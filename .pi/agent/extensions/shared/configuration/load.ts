import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { Check } from "typebox/value";
import type { Reviewer } from "../review/protocol.ts";
import { ModelState } from "./model-state.ts";
import {
  parseConfig,
  parseLocalConfig,
  resolvedConfigSchema,
  type Config,
  type LocalConfig,
  type PortableConfig,
} from "./schemas.ts";

type RuntimeOptions = { home?: string; searchPath?: string; reviewers?: Reviewer[] };

export async function assertSandboxReady(config: Config): Promise<void> {
  if (config.sandbox.backend !== "bwrap") return;

  for (const path of [config.sandbox.executable, config.sandbox.runnerExecutable]) {
    try {
      await access(path, constants.R_OK | constants.X_OK);

      if (!(await stat(path)).isFile()) throw new Error("not a regular file");
    } catch (error) {
      throw new Error(
        `Sandbox executable unavailable: ${path}. Restart Pi through ~/.local/bin/pi to prepare the default executor, or repair the custom path in auto-approval.device.json outside Pi. ${String(error)}`,
      );
    }
  }
}

async function findProgram(name: string, searchPath: string): Promise<string> {
  for (const directory of searchPath.split(delimiter)) {
    // Never select executable code from the agent's current project directory.
    if (!isAbsolute(directory)) continue;

    const candidate = join(directory, name);

    try {
      await access(candidate, constants.X_OK);

      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }

  throw new Error(
    `Sandbox program ${name} not found on PATH; install it or configure its absolute path in auto-approval.device.json outside Pi`,
  );
}

export async function resolveConfig(
  portable: PortableConfig,
  local: LocalConfig = {},
  runtime: RuntimeOptions = {},
): Promise<Config> {
  const paths = local.sandbox ?? {};
  const searchPath = runtime.searchPath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  let sandbox: Config["sandbox"];

  if (portable.sandbox.backend === "bwrap") {
    if (paths.dockerExecutable)
      throw new Error("dockerExecutable is incompatible with the configured bwrap backend");

    sandbox = {
      backend: "bwrap",
      executable: paths.executable ?? (await findProgram("bwrap", searchPath)),
      runnerExecutable:
        paths.runnerExecutable ??
        join(runtime.home ?? homedir(), ".local", "cache", "pi-auto-approval", "executor"),
      ...(paths.workspaceViews ? { workspaceViews: paths.workspaceViews } : {}),
      ...(paths.cgroupRoot ? { cgroupRoot: paths.cgroupRoot } : {}),
    };
  } else {
    if (paths.executable || paths.runnerExecutable || paths.workspaceViews || paths.cgroupRoot)
      throw new Error(
        "bwrap paths and workspaceViews are incompatible with the configured Docker backend",
      );

    sandbox = {
      backend: "docker",
      image: portable.sandbox.image,
      dockerExecutable: paths.dockerExecutable ?? (await findProgram("docker", searchPath)),
    };
  }

  if (
    local.credentialProfiles &&
    new Set(local.credentialProfiles.map((profile) => profile.name)).size !==
      local.credentialProfiles.length
  )
    throw new Error("Credential profile names must be unique");

  const resolved = {
    ...portable,
    reviewers: runtime.reviewers ?? [],
    sandbox,
    ...(local.credentialProfiles ? { credentialProfiles: local.credentialProfiles } : {}),
  };

  if (!Check(resolvedConfigSchema, resolved))
    throw new Error("Invalid resolved auto-approval configuration");

  return resolved;
}

async function readDeviceConfig(localPath: string): Promise<LocalConfig | undefined> {
  try {
    return parseLocalConfig(await readFile(localPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    // A broken symlink is an existing restriction file that cannot be loaded.
    // Only the complete absence of this optional file means no local overrides.
    const present = await lstat(localPath).then(
      () => true,
      (failure: NodeJS.ErrnoException) => {
        if (failure.code === "ENOENT") return false;

        throw failure;
      },
    );

    if (present) throw error;

    return undefined;
  }
}

export async function loadConfig(
  agentDirectory: string,
  runtime: RuntimeOptions = {},
): Promise<Config> {
  const portable = parseConfig(await readFile(join(agentDirectory, "auto-approval.json"), "utf8"));
  // Preserve restrictions on devices that still have the previous filename.
  const local =
    (await readDeviceConfig(join(agentDirectory, "auto-approval.device.json"))) ??
    (await readDeviceConfig(join(agentDirectory, "auto-approval.local.json"))) ??
    {};

  return await resolveConfig(portable, local, {
    ...runtime,
    reviewers: runtime.reviewers ?? new ModelState(agentDirectory).reviewers(),
  });
}
