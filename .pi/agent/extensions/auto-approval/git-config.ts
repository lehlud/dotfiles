import { constants } from "node:fs";
import { mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { executeIsolated, type Workspace } from "./isolation.ts";
import type { Config, Request } from "./policy.ts";
import { validateGitArgv, type GitConfigReader } from "./git-command.ts";
import { removeSessionTemporaryDirectory } from "./temporary-storage.ts";

const publicKeys = new Set([
  "user.name", "user.email", "user.useconfigonly", "user.signingkey", "commit.gpgsign", "tag.gpgsign", "gpg.format",
  "core.autocrlf", "core.eol", "core.safecrlf", "core.filemode", "core.ignorecase", "core.quotepath", "core.precomposeunicode",
  "color.ui", "init.defaultbranch", "pull.rebase", "pull.ff", "fetch.prune", "push.default", "push.followtags",
  "merge.ff", "merge.conflictstyle", "diff.algorithm", "diff.renames", "diff.renamelimit", "commit.cleanup", "commit.status", "tag.sort", "log.date",
]);
export function publicGitConfiguration(entries: [string, string][]): string {
  return entries.filter(([key]) => publicKeys.has(key.toLowerCase())).map(([key, value]) => {
    if (/[\u0000-\u0007\u000b-\u001f]/.test(value)) throw new Error("Unsupported control character in public Git configuration");
    const [section, name] = key.toLowerCase().split(".");
    const quoted = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\b", "\\b");
    return `[${section}]\n${name} = "${quoted}"\n`;
  }).join("");
}
export function validateGitRequest(request: Request, config: Config): void {
  if (request.sandbox?.gitConfig !== undefined && request.tool !== "git") throw new Error("gitConfig is available only to the argv-only Git tool");
  if (request.tool !== "git") return;
  validateGitArgv(request.arguments.argv as string[]);
  if (config.sandbox.backend !== "bwrap") throw new Error("The local Git route requires native Linux bwrap isolation");
  if (request.sandbox?.environment || request.sandbox?.tools || request.sandbox?.executableSearchPaths || request.sandbox?.network === "host") throw new Error("The local Git route uses a fixed offline runtime without additional tools or environment");
}
function entries(text: string): [string, string][] {
  return text.split("\0").filter(Boolean).map((record) => {
    const newline = record.indexOf("\n");
    if (newline < 0) return [record, "true"];
    return [record.slice(0, newline), record.slice(newline + 1)];
  });
}

// Nach Freigabe: Originale privat lesen, nur öffentliche Werte an Git delegieren.
export async function executeWithGitConfig(request: Request, workspace: Workspace, config: Config, signal?: AbortSignal, home = homedir(), xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config"), global = process.env.GIT_CONFIG_GLOBAL) {
  validateGitRequest(request, config);
  if (request.tool !== "git" || request.sandbox?.gitConfig !== true) throw new Error("No reviewed Git configuration grant");
  if (global !== undefined) global = resolve(workspace.cwd, global);
  const directory = await mkdtemp(join(tmpdir(), "pi-git-config-"));
  const snapshots: { source: string; target: string }[] = [], seen = new Set<string>();
  const fixedRequest: Request = { tool: "git", arguments: { argv: ["config"] }, sandbox: { network: "none", limits: { executionTimeoutMs: 10000 } }, goal: request.goal, justification: request.justification };
  const read = async (reader: GitConfigReader) => {
    const result = await executeIsolated(fixedRequest, { ...workspace, temporaryDirectory: undefined, readOnlyBindings: workspace.bindings, gitSnapshots: snapshots }, config.sandbox, signal, undefined, reader);
    return entries((result.content[0] as { text: string }).text);
  };
  const capture = async (path: string): Promise<void> => {
    signal?.throwIfAborted();
    const target = resolve(path);
    if (seen.has(target)) return;
    if (seen.size >= 64) throw new Error("Too many included Git configuration files");
    seen.add(target);
    let handle;
    try { handle = await open(await realpath(target), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Global Git configuration is unavailable"); }
    let data: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536) throw new Error("Global Git configuration must be a bounded regular file");
      const buffer = Buffer.alloc(65537), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw new Error("Global Git configuration size limit exceeded");
      data = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    const source = join(directory, `input-${snapshots.length}`);
    await writeFile(source, data, { mode: 0o400 }); snapshots.push({ source, target });
    for (const [key, value] of await read({ home, xdg, file: target })) {
      if (key.toLowerCase() !== "include.path" && !/^includeif\..*\.path$/i.test(key)) continue;
      if (value.startsWith("~") && !value.startsWith("~/")) throw new Error("Other-user Git include paths are unsupported");
      await capture(value.startsWith("~/") ? join(home, value.slice(2)) : isAbsolute(value) ? value : resolve(dirname(target), value));
    }
  };
  try {
    for (const path of global !== undefined ? [global] : [join(xdg, "git", "config"), join(home, ".gitconfig")]) await capture(path);
    const publicSource = join(directory, "public-config");
    const values = snapshots.length ? await read({ home, xdg, ...(global !== undefined ? { global } : {}) }) : [];
    await writeFile(publicSource, publicGitConfiguration(values), { mode: 0o400 });
    return await executeIsolated(request, { ...workspace, temporaryDirectory: undefined, gitSnapshots: [{ source: publicSource, target: "/opt/pi-git/config" }] }, config.sandbox, signal);
  } finally { await removeSessionTemporaryDirectory(directory); }
}
