import { access, lstat, readdir } from "node:fs/promises";
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

async function nodeSources(home: string): Promise<LocalTool["sources"]> {
  const sources: LocalTool["sources"] = [];
  for (const root of [join(home, ".local/share/nvm"), join(home, ".nvm/versions/node")]) {
    if (!await existing(root)) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const platform = `Linux-${process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch}`;
      if (!entry.isDirectory() || (!/^v\d+\.\d+\.\d+$/.test(entry.name) && entry.name !== platform)) continue;
      const source = join(root, entry.name);
      sources.push({ source, target: `/opt/pi-tools/source/node/${sources.length}${entry.name.startsWith("v") ? `/${entry.name}` : ""}` });
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
