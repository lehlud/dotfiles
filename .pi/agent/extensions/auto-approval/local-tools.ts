import { access, lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export type LocalTool = { name: string; sources: { source: string; target: string }[]; helper?: string };
export const toolRuntimeDirectory = join(dirname(fileURLToPath(import.meta.url)), "tool-runtime");

async function existing(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function regularExecutable(path: string, executable = true): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Local tool launcher must be a regular file without external aliases: ${path}`);
  await access(path, constants.R_OK | (executable ? constants.X_OK : 0));
}

/** Inspect the ELF header without executing shared-home Node code on the host. */
export async function nativeLinuxNode(binary: string, architecture = process.arch): Promise<boolean> {
  const machine = architecture === "x64" ? 62 : architecture === "arm64" ? 183 : undefined;
  if (!machine) return false;
  let file;
  try {
    file = await open(binary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || !(stat.mode & 0o111)) return false;
    const header = Buffer.alloc(64);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead === 64 && header.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1]))
      && [0, 3].includes(header[7]) && [2, 3].includes(header.readUInt16LE(16))
      && header.readUInt16LE(18) === machine && header.readUInt32LE(20) === 1 && header.readUInt16LE(52) === 64;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally { await file?.close(); }
}

async function nodeSources(home: string): Promise<LocalTool["sources"]> {
  const sources: LocalTool["sources"] = [];
  const platform = `Linux-${process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch}`;
  for (const root of [join(home, ".local/share/nvm", platform), join(home, ".local/share/nvm"), join(home, ".nvm/versions/node")]) {
    if (!await existing(root)) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^v\d+\.\d+\.\d+$/.test(entry.name)) continue;
      const source = join(root, entry.name);
      if (!await nativeLinuxNode(join(source, "bin/node"))) continue;
      sources.push({ source, target: `/opt/pi-tools/source/node/${sources.length}/${entry.name}` });
    }
  }
  // With no installed runtime, nvm install can bootstrap into private /tmp.
  return sources;
}

export async function resolveLocalTools(names: readonly string[] = [], home = homedir()): Promise<LocalTool[]> {
  const tools: LocalTool[] = [];
  const canonical = [...new Set(names.map((name) => ["node", "nvm", "npm", "npx", "corepack"].includes(name) ? "node" : name))];
  for (const name of canonical) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name)) throw new Error("Invalid local tool name");
    if (name === "wpscan") throw new Error("This WPScan launcher requires an external container engine; use a native installation instead. Container sockets are not exposed.");
    if (name === "node") { tools.push({ name, sources: await nodeSources(home) }); continue; }
    const launcher = join(home, ".local/bin", name);
    await regularExecutable(launcher);
    const sources = [{ source: launcher, target: `/opt/pi-tools/source/${name}/launcher` }];
    const cache = join(home, ".local/cache", name);
    if (await existing(cache)) sources.push({ source: cache, target: `/opt/pi-tools/source/${name}/cache` });
    const helper = join(home, ".local/bin/auto-update-app.bash");
    if (await existing(helper)) await regularExecutable(helper, false);
    tools.push({ name, sources, ...(await existing(helper) ? { helper } : {}) });
  }
  return tools;
}
