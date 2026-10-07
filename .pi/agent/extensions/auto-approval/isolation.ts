import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readlink, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getuid, getgid } from "node:process";
import { homedir } from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Config, Request, SandboxRequest } from "./policy.ts";
import { resolveLocalTools, toolRuntimeDirectory, type LocalTool } from "./local-tools.ts";
import type { WebRuntime } from "../web-research/runtime.ts";
import type { CredentialExecution } from "./credential-command.ts";
import type { GitConfigReader } from "./git-command.ts";
export type SandboxConfig = Config["sandbox"];
export type Workspace = { path: string; cwd: string; bindings: string[]; readOnlyBindings?: string[]; searchPaths?: string[]; localTools?: LocalTool[]; webRuntime?: WebRuntime; credentialExecutable?: string; gitSnapshots?: { source: string; target: string }[]; temporaryDirectory?: string; masked: { path: string; directory: boolean }[] };
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};
const backendPaths = (config: SandboxConfig) => config.backend === "bwrap"
  ? [config.executable, config.runnerExecutable] : [config.dockerExecutable];

export function sandboxHostPath(workspace: Workspace, path: string): string {
  const absolute = resolve(workspace.cwd, path);
  if (!workspace.temporaryDirectory || !within("/tmp", absolute) || workspace.bindings.some((binding) => within(binding, absolute))) return absolute;
  return join(workspace.temporaryDirectory, relative("/tmp", absolute));
}

type TemporaryMountpoint = { path: string; dev: number; ino: number };

async function temporaryMountpoints(workspace: Workspace): Promise<TemporaryMountpoint[]> {
  if (!workspace.temporaryDirectory) return [];
  const created: TemporaryMountpoint[] = [];
  for (const guest of ["/tmp/home", "/tmp/pi", ...workspace.bindings.filter((path) => within("/tmp", path))]) {
    const target = join(workspace.temporaryDirectory, relative("/tmp", guest));
    let path = target;
    if (await unsafeTemporaryParent(workspace.temporaryDirectory, path)) continue;
    const absent: string[] = [];
    while (path !== workspace.temporaryDirectory) {
      try { await lstat(path); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      absent.push(path);
      path = dirname(path);
    }
    const directory = guest === "/tmp/home" || guest === "/tmp/pi" || (await lstat(guest)).isDirectory();
    for (const path of absent.reverse()) {
      try {
        if (path !== target || directory) await mkdir(path, { mode: 0o700 });
        else await writeFile(path, "", { flag: "wx", mode: 0o600 });
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      const stat = await lstat(path);
      created.push({ path, dev: stat.dev, ino: stat.ino });
    }
  }
  return created.sort((a, b) => b.path.length - a.path.length);
}

async function unsafeTemporaryParent(root: string, path: string): Promise<boolean> {
  let current = root;
  for (const part of relative(root, dirname(path)).split("/").filter(Boolean)) {
    current = join(current, part);
    try { if (!(await lstat(current)).isDirectory()) return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

async function cleanTemporaryMountpoints(root: string | undefined, paths: TemporaryMountpoint[]): Promise<void> {
  if (!root) return;
  for (const entry of paths) {
    const path = entry.path;
    if (await unsafeTemporaryParent(root, path)) continue;
    try {
      const stat = await lstat(path);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino) continue;
      if (stat.isDirectory()) await rmdir(path);
      else if (stat.isFile() && stat.size === 0 && stat.nlink === 1) await unlink(path);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

/** A home-level dotfiles repository must never enlarge an unrelated directory. */
export async function detectWorkspace(cwd: string, home = homedir()): Promise<{ path: string; cwd: string }> {
  const current = await realpath(cwd);
  const homePath = await realpath(home).catch(() => resolve(home));
  const git = spawn("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", current, "rev-parse", "--show-toplevel"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  let output = "";
  git.stdout.on("data", (chunk) => { if (output.length < 65536) output += chunk.toString(); });
  const code = await new Promise<number | null>((done) => { git.once("error", () => done(null)); git.once("close", done); });
  if (code === 0) {
    const root = await realpath(output.trim()).catch(() => undefined);
    if (root && within(root, current) && !within(root, homePath)) return { path: root, cwd: current };
  }
  return { path: current, cwd: current };
}

/** Validate project views; credential calls otherwise mount only explicitly requested paths. */
export async function validateWorkspace(cwd: string, config: SandboxConfig, protectedPaths: readonly string[], request?: SandboxRequest, privateTemporaryDirectory?: string, mode: "project" | "web" | "credential" = "project"): Promise<Workspace> {
  if (mode === "web" && (request?.paths?.length || request?.executableSearchPaths?.length || request?.tools?.length)) throw new Error("Web research uses no project files, extra path mounts or local tools; remove those access requests");
  const detected = mode !== "project" ? { path: "/workspace", cwd: "/workspace" } : await detectWorkspace(cwd);
  const temporaryDirectory = privateTemporaryDirectory ? await realpath(privateTemporaryDirectory) : undefined;
  if (temporaryDirectory && !(await lstat(temporaryDirectory)).isDirectory()) throw new Error("Private /tmp backing storage must be a directory");
  if (temporaryDirectory && (within(detected.path, temporaryDirectory) || within(temporaryDirectory, detected.path))) throw new Error("Workspace overlaps private sandbox temporary storage");
  if (temporaryDirectory && request?.limits?.tmpBytes !== undefined) throw new Error("tmpBytes cannot limit a persistent disk-backed /tmp; omit it for session temporary storage");
  const workspace = detected.path;
  const root = workspace;
  const protectedRoots = await Promise.all([...protectedPaths, ...backendPaths(config)].map((path) => realpath(path).catch(() => resolve(path))));
  if (mode === "project" && protectedRoots.some((path) => within(path, workspace))) throw new Error("Workspace is inside protected Pi, approval, or credential storage; choose a separate project directory");
  let bindings = mode !== "project" ? [] : [workspace];
  if (mode === "project" && config.backend === "bwrap") {
    const view = config.workspaceViews?.find((entry) => resolve(entry.root) === root);
    if (view) {
      bindings = [];
      for (const path of view.paths) {
        const canonical = await realpath(path);
        if (!within(root, canonical)) throw new Error(`Configured workspace view escapes its authorized root: ${path}`);
        if (within(canonical, workspace)) bindings.push(workspace);
        else if (within(workspace, canonical)) bindings.push(canonical);
      }
      bindings = [...new Set(bindings)].sort((a, b) => a.length - b.length)
        .filter((path, index, all) => !all.slice(0, index).some((parent) => within(parent, path)));
      if (!bindings.length) throw new Error(`Directory ${workspace} is outside the operator-configured workspace view; edit sandbox.workspaceViews in ~/.pi/agent/auto-approval.device.json outside Pi.`);
    } else if (workspace === await realpath(homedir())) {
      throw new Error("The home directory needs a restricted workspaceViews entry containing public files; edit ~/.pi/agent/auto-approval.device.json outside Pi. Project workspaces are detected automatically.");
    }
  } else if (mode === "project" && config.backend !== "bwrap" && protectedRoots.some((path) => within(workspace, path))) {
    throw new Error("Workspace overlaps Pi, its gate, or protected configuration");
  }
  if (config.backend === "bwrap" && request?.limits && [request.limits.memoryMiB, request.limits.cpus, request.limits.pids].some((value) => value !== undefined)) {
    throw new Error("Memory, CPU and PID cgroup limits require the Docker backend; bwrap supports executionTimeoutMs, maxOutputBytes and tmpBytes.");
  }
  const projectAccess: "read" | "write" = request?.projectFiles ?? "write";
  const modes = new Map(bindings.map((path) => [path, projectAccess]));
  const home = await realpath(homedir());
  const searchPaths: string[] = [];
  const localTools = await resolveLocalTools(request?.tools);
  if (localTools.length && !temporaryDirectory) throw new Error("Local tools require session-private temporary storage");
  const toolSources = localTools.flatMap((tool) => tool.sources);
  const toolRoots = await Promise.all(toolSources.map(({ source }) => realpath(source)));
  const writableGrants = [...bindings, ...(request?.paths ?? []).filter((entry) => entry.access === "write").map((entry) => entry.path)];
  for (const grant of writableGrants) {
    const path = await realpath(grant);
    if (toolRoots.some((root) => within(root, path) || within(path, root))) throw new Error("Local tool installations must remain read-only; writable grants cannot overlap them");
  }
  const extra = [...(request?.paths ?? []), ...(request?.executableSearchPaths ?? []).map((path) => ({ path, access: "read" as const })), ...toolSources.map(({ source: path }) => ({ path, access: "read" as const }))];
  for (const entry of extra) {
    const path = await realpath(entry.path);
    if (temporaryDirectory && (within(path, temporaryDirectory) || within(temporaryDirectory, path))) throw new Error("Additional access overlaps private sandbox temporary storage");
    const stat = await lstat(path);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Additional access needs an existing regular file or directory: ${entry.path}`);
    if (/[\n\r,]/.test(path) || within(path, home)) throw new Error("Additional access cannot expose the whole home directory or its ancestors");
    if (["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/tmp"].includes(path) || ["/proc", "/dev", "/executor", "/opt/pi-tools", "/tmp/home", "/tmp/pi-tools"].some((root) => within(root, path))) throw new Error("Additional access overlaps sandbox runtime infrastructure");
    if (protectedRoots.some((root) => within(root, path) || within(path, root))) throw new Error(`Additional access overlaps protected Pi or credential storage: ${entry.path}`);
    if (request?.executableSearchPaths?.includes(entry.path)) {
      if (!stat.isDirectory()) throw new Error("Executable search paths must be directories");
      searchPaths.push(path);
      // A search path never silently downgrades an explicitly writable mount.
      if (modes.has(path)) continue;
    }
    modes.set(path, entry.access);
  }
  bindings = [...modes.keys()].sort((a, b) => a.length - b.length);
  const readOnlyBindings = bindings.filter((path) => modes.get(path) === "read");
  const writable = (path: string) => (temporaryDirectory && within(temporaryDirectory, path)) || modes.get(bindings.filter((root) => within(root, path)).at(-1)!) === "write";
  const masked: Workspace["masked"] = [];
  for (const binding of bindings) {
    if (/[\n\r,]/.test(binding)) throw new Error("Workspace path contains unsafe mount characters");
    if (protectedRoots.some((path) => within(path, binding))) throw new Error(`Workspace view includes protected storage: ${binding}`);
    for (const path of protectedRoots.filter((path) => within(binding, path))) {
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (stat) masked.push({ path, directory: stat.isDirectory() });
    }
  }
  const hidden = (path: string) => masked.some((entry) => within(entry.path, path));
  // Rust/Cargo and other build tools use hardlinks between output and deps.
  // The inode is writable only when every directory entry is exposed here.
  const hardlinks = new Map<string, { path: string; expected: number; seen: number; write: boolean; read: boolean }>();
  const walk = async (path: string): Promise<void> => {
    if (hidden(path)) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      // Private /tmp links resolve in the isolated namespace, never host /tmp.
      const targetPath = resolve(dirname(path), await readlink(path));
      if (temporaryDirectory && (within(temporaryDirectory, path) || (within("/tmp", targetPath) && !bindings.some((binding) => within(binding, targetPath))))) return;
      // Build caches commonly leave dangling links. They expose no target;
      // the isolated filesystem also cannot resolve missing host paths.
      const target = await realpath(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      });
      if (!target) return;
      // Native bwrap already exposes /usr read-only. Virtualenv links to its
      // system Python need no additional host access or writable mount.
      const systemRuntime = config.backend === "bwrap" && within("/usr", target);
      if (hidden(target) || protectedRoots.some((root) => within(root, target)) || (!systemRuntime && !bindings.some((binding) => within(binding, target)))) throw new Error(`Workspace symlink escapes its exposed boundary: ${path}`);
    } else if (stat.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name));
    } else if (!stat.isFile()) throw new Error(`Workspace contains a special file: ${path}`);
    else if (stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      const entry = hardlinks.get(key);
      if (entry) {
        if (entry.expected !== stat.nlink) throw new Error(`Workspace hardlink changed during validation: ${path}`);
        entry.seen++;
        entry.write ||= writable(path); entry.read ||= !writable(path);
      } else hardlinks.set(key, { path, expected: stat.nlink, seen: 1, write: writable(path), read: !writable(path) });
    }
  };
  // Nested mounts must not cause the same inode entry to be counted twice.
  for (const path of [...bindings.filter((path, index) => !bindings.slice(0, index).some((parent) => within(parent, path))), ...(temporaryDirectory ? [temporaryDirectory] : [])]) await walk(path);
  for (const entry of hardlinks.values()) {
    if (entry.seen !== entry.expected) throw new Error(`Workspace hardlink has aliases outside its exposed boundary: ${entry.path}`);
    if (entry.write && entry.read) throw new Error(`Writable hardlink would modify a read-only grant: ${entry.path}`);
  }
  return { ...detected, bindings, readOnlyBindings, searchPaths, masked, ...(localTools.length ? { localTools } : {}), ...(temporaryDirectory ? { temporaryDirectory } : {}) };
}

function localToolArguments(workspace: Workspace, native: boolean): string[] {
  const tools = workspace.localTools ?? [];
  if (!tools.length) return [];
  const sources = [{ source: toolRuntimeDirectory, target: "/opt/pi-tools/runtime" }, ...tools.flatMap((tool) => tool.sources)];
  for (const tool of tools) {
    if (tool.helper) sources.push({ source: tool.helper, target: `/opt/pi-tools/source/${tool.name}/helper` });
  }
  return sources.flatMap(({ source, target }) => native ? ["--ro-bind", source, target] : ["--mount", `type=bind,src=${source},dst=${target},bind-recursive=disabled,readonly`]);
}

function webRuntimeArguments(workspace: Workspace, native: boolean): string[] {
  if (!workspace.webRuntime) return [];
  const { dependencies, worker } = workspace.webRuntime;
  return [{ source: dependencies, target: "/opt/pi-web/dependencies" }, { source: worker, target: "/opt/pi-web/worker.py" }]
    .flatMap(({ source, target }) => native ? ["--ro-bind", source, target] : ["--mount", `type=bind,src=${source},dst=${target},bind-recursive=disabled,readonly`]);
}

export function sandboxArguments(workspace: Workspace, config: SandboxConfig, name: string, request?: SandboxRequest) {
  const limits = request?.limits;
  const uid = getuid?.() ?? 501;
  const gid = getgid?.() ?? 20;
  const runtimeTmpfs = `rw,nosuid,nodev,size=268435456,mode=0700,uid=${uid},gid=${gid}`;
  if (workspace.temporaryDirectory && limits?.tmpBytes !== undefined) throw new Error("tmpBytes cannot limit a persistent disk-backed /tmp; omit it for session temporary storage");
  const environment = { ...(workspace.searchPaths?.length ? { PATH: [...workspace.searchPaths, "/usr/bin", "/bin"].join(":") } : {}), ...request?.environment };
  if (Object.keys(environment).some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) || Object.values(environment).some((value) => value.includes("\0"))) throw new Error("Invalid sandbox environment");
  if (config.backend !== "bwrap") return ["run", "--rm", "--interactive", "--name", name,
    "--pull", "never", "--network", request?.network ?? "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--ipc", "none", "--cgroupns", "private",
    "--pids-limit", String(limits?.pids ?? 128), "--memory", `${limits?.memoryMiB ?? 1024}m`, "--cpus", String(limits?.cpus ?? 2),
    "--user", `${uid}:${gid}`,
    ...(workspace.temporaryDirectory ? ["--mount", `type=bind,src=${workspace.temporaryDirectory},dst=/tmp,bind-recursive=disabled`, "--tmpfs", `/tmp/home:${runtimeTmpfs}`, "--tmpfs", `/tmp/pi:${runtimeTmpfs}`] : ["--tmpfs", `/tmp:rw,nosuid,nodev,size=${limits?.tmpBytes ?? 268435456},mode=1777`]),
    ...(!workspace.bindings.length ? ["--tmpfs", `${workspace.path}:ro,nosuid,nodev,noexec,size=16777216`] : []),
    "--env", "HOME=/tmp/home", "--env", "PI_CODING_AGENT_DIR=/tmp/pi",
    ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...workspace.bindings.flatMap((path) => ["--mount", `type=bind,src=${path},dst=${path},bind-recursive=disabled${workspace.readOnlyBindings?.includes(path) ? ",readonly" : ""}`]),
    ...localToolArguments(workspace, false),
    ...webRuntimeArguments(workspace, false),
    "--workdir", workspace.cwd, "--entrypoint", workspace.localTools?.length ? "/bin/bash" : "/usr/local/bin/bun", config.image,
    ...(workspace.localTools?.length ? ["/opt/pi-tools/runtime/bootstrap.sh", ...workspace.localTools.map((tool) => tool.name), "--", "/usr/local/bin/bun"] : []), "/executor/runner.ts"];
  const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session",
    "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache", "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
    "--proc", "/proc", "--dev", "/dev",
    ...(workspace.temporaryDirectory ? ["--bind", workspace.temporaryDirectory, "/tmp", "--size", "268435456", "--tmpfs", "/tmp/home", "--size", "268435456", "--tmpfs", "/tmp/pi"] : ["--size", String(limits?.tmpBytes ?? 268435456), "--tmpfs", "/tmp", "--dir", "/tmp/home"]),
    "--ro-bind", config.runnerExecutable, "/executor/runner",
    "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp/home",
    "--setenv", "PI_CODING_AGENT_DIR", "/tmp/pi", "--setenv", "LANG", "C.UTF-8"];
  if (request?.network === "host") args.push("--share-net");
  if (request?.network === "host") {
    for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"]) args.push("--ro-bind-try", path, path);
  }
  for (const [key, value] of Object.entries(environment)) args.push("--setenv", key, value);
  if (!workspace.bindings.includes(workspace.path)) args.push("--size", "16777216", "--tmpfs", workspace.path);
  for (const path of workspace.bindings) args.push(workspace.readOnlyBindings?.includes(path) ? "--ro-bind" : "--bind", path, path);
  for (const entry of workspace.masked) {
    if (entry.directory) args.push("--perms", "000", "--tmpfs", entry.path, "--remount-ro", entry.path);
    else args.push("--ro-bind", "/dev/null", entry.path);
  }
  args.push(...localToolArguments(workspace, true));
  args.push(...webRuntimeArguments(workspace, true));
  if (workspace.credentialExecutable) args.push("--ro-bind", workspace.credentialExecutable, "/opt/pi-credential/tool");
  for (const { source, target } of workspace.gitSnapshots ?? []) args.push("--ro-bind", source, target);
  // Projected parent directories are ephemeral and read-only. Only mounts persist.
  if (!workspace.bindings.includes(workspace.path)) args.push("--remount-ro", workspace.path);
  args.push("--chdir", workspace.cwd, ...(workspace.localTools?.length ? ["/bin/bash", "/opt/pi-tools/runtime/bootstrap.sh", ...workspace.localTools.map((tool) => tool.name), "--"] : []), "/executor/runner");
  return args;
}

/** Both backends are mandatory isolation. A launch failure never executes on the host. */
export async function executeIsolated(request: Request, workspace: Workspace, config: SandboxConfig, signal?: AbortSignal, credentialExecution?: CredentialExecution, gitConfigReader?: GitConfigReader): Promise<AgentToolResult<any>> {
  signal?.throwIfAborted();
  const input = JSON.stringify({ ...request, ...(credentialExecution ? { credentialExecution } : {}), ...(gitConfigReader ? { gitConfigReader } : {}) });
  if (Buffer.byteLength(input) > 100000) throw new Error("Executor input limit exceeded");
  const name = `pi-approved-${randomUUID()}`;
  const native = config.backend === "bwrap";
  const executable = native ? config.executable : config.dockerExecutable;
  // Bind mount scaffolding must not survive an action-specific access grant.
  const mountpoints = await temporaryMountpoints(workspace);
  const child = spawn(executable, sandboxArguments(workspace, config, name, request.sandbox), { stdio: ["pipe", "pipe", "pipe"], detached: native });
  let stdout = "", stderr = "";
  let failure: Error | undefined;
  let cleanup: Promise<void> | undefined;
  const remove = () => {
    if (!cleanup) cleanup = native ? Promise.resolve().then(() => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    }) : new Promise<void>((done) => {
      const rm = spawn(executable, ["rm", "--force", name], { stdio: "ignore" });
      rm.once("error", () => done()); rm.once("close", () => done());
    });
    return cleanup;
  };
  const stop = (reason: string) => { failure ??= new Error(reason); void remove(); child.kill("SIGTERM"); };
  const abort = () => stop("Isolated execution cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  const watchdog = setTimeout(() => stop("Isolated executor exceeded the technical execution limit"), request.sandbox?.limits?.executionTimeoutMs ?? 600000);
  try {
    const exited = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > (request.sandbox?.limits?.maxOutputBytes ?? 16 * 1024 * 1024)) stop("Executor output limit exceeded");
    });
    child.stderr.on("data", (chunk) => { if (stderr.length < 20000) stderr += chunk.toString(); });
    child.stdin.on("error", () => {});
    if (signal?.aborted) abort(); else child.stdin.end(input);
    const code = await exited;
    if (failure) throw failure;
    if (code !== 0) throw new Error(`Mandatory ${native ? "bwrap" : "Docker"} sandbox failed (${code}); no local fallback. ${stderr.trim()}`);
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || !Array.isArray((result as any).content)) throw new Error("Invalid executor result");
    return result as AgentToolResult<any>;
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", abort);
    await remove();
    await cleanTemporaryMountpoints(workspace.temporaryDirectory, mountpoints);
  }
}
