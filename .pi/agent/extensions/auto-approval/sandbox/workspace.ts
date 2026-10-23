import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type { SandboxRequest } from "../../shared/contracts/action.ts";
import { resolveLocalTools } from "../local-tools.ts";
import { assertWorkspaceBoundary } from "./boundary.ts";
import { assertToolHost } from "./tool-host.ts";
import { within, backendPaths } from "./paths.ts";
import type { SandboxConfig, Workspace } from "./types.ts";
import { planCgroup } from "./cgroup-plan.ts";
import { assertCgroupsHidden } from "./cgroup-boundary.ts";

/** A home-level dotfiles repository must never enlarge an unrelated directory. */
export async function detectWorkspace(
  cwd: string,
  home = homedir(),
): Promise<{ path: string; cwd: string }> {
  const current = await realpath(cwd);
  const homePath = await realpath(home).catch(() => resolve(home));
  const git = spawn(
    "/usr/bin/git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      current,
      "rev-parse",
      "--show-toplevel",
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
  let output = "";

  git.stdout.on("data", (chunk) => {
    if (output.length < 65536) output += chunk.toString();
  });

  const code = await new Promise<number | null>((done) => {
    git.once("error", () => done(null));
    git.once("close", done);
  });

  if (code === 0) {
    const root = await realpath(output.trim()).catch(() => undefined);

    if (root && within(root, current) && !within(root, homePath))
      return { path: root, cwd: current };
  }

  return { path: current, cwd: current };
}

/** Validate project views; credential calls otherwise mount only explicitly requested paths. */
export async function validateWorkspace(
  cwd: string,
  config: SandboxConfig,
  protectedPaths: readonly string[],
  request?: SandboxRequest,
  privateTemporaryDirectory?: string,
  mode: "project" | "web" | "credential" | "scoped" = "project",
  homeDirectory = homedir(),
): Promise<Workspace> {
  await assertToolHost(request?.tools, config);

  if (
    mode === "web" &&
    (request?.paths?.length || request?.executableSearchPaths?.length || request?.tools?.length)
  )
    throw new Error(
      "Web research uses no project files, extra path mounts or local tools; remove those access requests",
    );

  const detected =
    mode === "scoped"
      ? { path: await realpath(cwd), cwd: await realpath(cwd) }
      : mode !== "project"
        ? { path: "/workspace", cwd: "/workspace" }
        : await detectWorkspace(cwd, homeDirectory);
  const temporaryDirectory = privateTemporaryDirectory
    ? await realpath(privateTemporaryDirectory)
    : undefined;

  if (temporaryDirectory && !(await lstat(temporaryDirectory)).isDirectory())
    throw new Error("Private /tmp backing storage must be a directory");

  if (
    temporaryDirectory &&
    (within(detected.path, temporaryDirectory) || within(temporaryDirectory, detected.path))
  )
    throw new Error("Workspace overlaps private sandbox temporary storage");

  if (temporaryDirectory && request?.limits?.tmpBytes !== undefined)
    throw new Error(
      "tmpBytes cannot limit a persistent disk-backed /tmp; omit it for session temporary storage",
    );

  const workspace = detected.path;
  const protectedRoots = await Promise.all(
    [...protectedPaths, ...backendPaths(config)].map((path) =>
      realpath(path).catch(() => resolve(path)),
    ),
  );

  if (mode === "project" && protectedRoots.some((path) => within(path, workspace)))
    throw new Error(
      "Workspace is inside protected Pi, approval, or credential storage; choose a separate project directory",
    );

  let bindings = await projectBindings(workspace, config, protectedRoots, mode, homeDirectory);

  const cgroup = await planCgroup(config, request?.limits);

  const access = await additionalGrants(
    bindings,
    request,
    temporaryDirectory,
    protectedRoots,
    config.backend === "bwrap",
    homeDirectory,
  );

  bindings = access.bindings;

  const { modes, localTools, searchPaths, readOnlyBindings, pendingPaths } = access;
  const writable = (path: string) =>
    (temporaryDirectory && within(temporaryDirectory, path)) ||
    modes.get(bindings.filter((root) => within(root, path)).at(-1)!) === "write";
  const masked = await protectedMasks(bindings, protectedRoots);
  const plan: Workspace = {
    ...detected,
    bindings,
    readOnlyBindings,
    ...(pendingPaths.length ? { pendingPaths } : {}),
    searchPaths,
    masked,
    ...(localTools.length ? { localTools } : {}),
    ...(temporaryDirectory ? { temporaryDirectory } : {}),
    ...(cgroup ? { cgroup } : {}),
  };

  await assertCgroupsHidden(plan);
  await assertWorkspaceBoundary(plan, protectedRoots, config, writable);

  return plan;
}

async function projectBindings(
  workspace: string,
  config: SandboxConfig,
  protectedRoots: string[],
  mode: "project" | "web" | "credential" | "scoped",
  homeDirectory: string,
) {
  const root = workspace;
  let bindings = mode !== "project" ? [] : [workspace];

  if (
    mode === "project" &&
    config.backend !== "bwrap" &&
    workspace === (await realpath(homeDirectory))
  )
    return [];

  if (mode === "project" && config.backend === "bwrap") {
    const view = config.workspaceViews?.find((entry) => resolve(entry.root) === root);

    if (view) {
      bindings = [];

      for (const path of view.paths) {
        const canonical = await realpath(path);

        if (!within(root, canonical))
          throw new Error(`Configured workspace view escapes its authorized root: ${path}`);

        if (within(canonical, workspace)) bindings.push(workspace);
        else if (within(workspace, canonical)) bindings.push(canonical);
      }

      bindings = [...new Set(bindings)]
        .sort((a, b) => a.length - b.length)
        .filter((path, index, all) => !all.slice(0, index).some((parent) => within(parent, path)));

      if (!bindings.length)
        throw new Error(
          `Directory ${workspace} is outside the operator-configured workspace view; edit sandbox.workspaceViews in ~/.pi/agent/auto-approval.device.json outside Pi.`,
        );
    } else if (workspace === (await realpath(homeDirectory))) {
      // Home starts as an empty projection; each action grants only the paths it needs.
      bindings = [];
    }
  } else if (
    mode === "project" &&
    config.backend !== "bwrap" &&
    protectedRoots.some((path) => within(workspace, path))
  ) {
    if (workspace === (await realpath(homeDirectory))) bindings = [];
    else throw new Error("Workspace overlaps Pi, its gate, or protected configuration");
  }

  return bindings;
}

async function additionalGrants(
  bindings: string[],
  request: SandboxRequest | undefined,
  temporaryDirectory: string | undefined,
  protectedRoots: string[],
  canMask: boolean,
  homeDirectory: string,
) {
  const projectAccess: "read" | "write" = request?.projectFiles ?? "write";
  const modes = new Map(bindings.map((path) => [path, projectAccess]));
  const home = await realpath(homeDirectory);
  const pendingPaths: NonNullable<Workspace["pendingPaths"]> = [];
  const searchPaths: string[] = [];
  const localTools = await resolveLocalTools(request?.tools);

  if (localTools.length && !temporaryDirectory)
    throw new Error("Local tools require session-private temporary storage");

  const toolSources = localTools.flatMap((tool) => tool.sources);
  const toolRoots = await Promise.all(toolSources.map(({ source }) => realpath(source)));
  const writableGrants = [
    ...bindings,
    ...(request?.paths ?? [])
      .filter((entry) => entry.access === "write")
      .map((entry) => entry.path),
  ];

  for (const grant of writableGrants) {
    const path = await realpath(grant).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;

      return resolve(grant);
    });

    if (toolRoots.some((root) => within(root, path) || within(path, root)))
      throw new Error(
        "Local tool installations must remain read-only; writable grants cannot overlap them",
      );
  }

  const extra = [
    ...(request?.paths ?? []),
    ...(request?.executableSearchPaths ?? []).map((path) => ({ path, access: "read" as const })),
    ...toolSources.map(({ source: path }) => ({ path, access: "read" as const })),
  ];

  for (const entry of extra) {
    let path: string;
    let metadata;

    try {
      path = await realpath(entry.path);
      metadata = await lstat(path);

      if ("create" in entry && entry.create)
        throw new Error(
          "Creation target already exists; remove create and review the existing occupant",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

      if (!("create" in entry) || !entry.create || entry.access !== "write")
        throw new Error(
          "A missing grant needs write access and create: file/directory with an existing parent",
        );

      if (!canMask) throw new Error("Scoped creation requires the native bwrap backend");

      const parent = await realpath(dirname(entry.path));
      const info = await lstat(parent, { bigint: true });

      if (!info.isDirectory()) throw new Error("Creation parent must be an existing directory");

      path = resolve(parent, basename(entry.path));
      pendingPaths.push({
        path,
        parent,
        device: info.dev.toString(),
        inode: info.ino.toString(),
        create: entry.create,
      });
    }

    if (
      temporaryDirectory &&
      (within(path, temporaryDirectory) || within(temporaryDirectory, path))
    )
      throw new Error("Additional access overlaps private sandbox temporary storage");

    if (metadata && !metadata.isFile() && !metadata.isDirectory())
      throw new Error(
        `Additional access needs an existing regular file or directory: ${entry.path}`,
      );

    if (/[\n\r,]/.test(path) || within(path, home))
      throw new Error("Additional access cannot expose the whole home directory or its ancestors");

    if (
      ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/tmp"].includes(path) ||
      ["/proc", "/dev", "/sys", "/executor", "/opt/pi-tools", "/tmp/home", "/tmp/pi-tools"].some(
        (root) => within(root, path),
      )
    )
      throw new Error("Additional access overlaps sandbox runtime infrastructure");

    if (canMask) {
      for (const root of protectedRoots.filter((root) => within(path, root) && root !== path)) {
        const exists = await lstat(root).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;

          throw error;
        });

        if (!exists)
          throw new Error(
            "Select a narrower grant: its parent contains a reserved private path that does not exist yet",
          );
      }
    }

    if (protectedRoots.some((root) => within(root, path) || (!canMask && within(path, root))))
      throw new Error(
        `Additional access overlaps protected Pi or credential storage: ${entry.path}`,
      );

    if (request?.executableSearchPaths?.includes(entry.path)) {
      if (!metadata?.isDirectory()) throw new Error("Executable search paths must be directories");

      searchPaths.push(path);

      // A search path never silently downgrades an explicitly writable mount.
      if (modes.has(path)) continue;
    }

    modes.set(path, entry.access);
  }

  bindings = [...modes.keys()].sort((a, b) => a.length - b.length);

  const readOnlyBindings = bindings.filter((path) => modes.get(path) === "read");

  return { bindings, modes, localTools, searchPaths, readOnlyBindings, pendingPaths };
}

async function protectedMasks(bindings: string[], protectedRoots: string[]) {
  const masked: Workspace["masked"] = [];

  for (const binding of bindings) {
    if (/[\n\r,]/.test(binding)) throw new Error("Workspace path contains unsafe mount characters");

    if (protectedRoots.some((path) => within(path, binding)))
      throw new Error(`Workspace view includes protected storage: ${binding}`);

    for (const path of protectedRoots.filter((path) => within(binding, path))) {
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;

        throw error;
      });

      if (stat) masked.push({ path, directory: stat.isDirectory() });
    }
  }

  return masked;
}
