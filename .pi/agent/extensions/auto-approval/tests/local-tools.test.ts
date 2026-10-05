import { afterAll, beforeAll, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalTools } from "../local-tools.ts";
import { executeIsolated, validateWorkspace, type SandboxConfig } from "../isolation.ts";

const fixture = await mkdtemp(join(tmpdir(), "pi-local-tools-test-"));
const home = join(fixture, "fake-home");
const project = join(fixture, "project");
const storage = join(fixture, "storage");
const launcher = join(home, ".local/bin/sampleapp");
const cache = join(home, ".local/cache/sampleapp");
const helper = join(home, ".local/bin/auto-update-app.bash");
let native: SandboxConfig;
const bwrap = Bun.which("bwrap");
const nativeTest = process.platform === "linux" && bwrap ? test : test.skip;

beforeAll(async () => {
  for (const path of [project, storage, join(home, ".local/bin"), cache]) await mkdir(path, { recursive: true });
  await writeFile(helper, 'sample_helper() { printf helper-ready; }\n', { mode: 0o644 });
  await writeFile(join(cache, "marker"), "host-seed");
  await writeFile(launcher, '#!/bin/bash\nsource "$HOME/.local/bin/auto-update-app.bash"\nsample_helper\ncat "$HOME/.local/cache/sampleapp/marker"\nprintf private-update > "$HOME/.local/cache/sampleapp/marker"\n', { mode: 0o755 });
  if (!bwrap || process.platform !== "linux") return;
  const runner = join(fixture, "runner");
  const built = Bun.spawnSync([process.execPath, "build", "--compile", resolve(import.meta.dir, "../runner.ts"), "--outfile", runner], { stdout: "pipe", stderr: "pipe" });
  if (built.exitCode) throw new Error(built.stderr.toString());
  native = { backend: "bwrap", executable: bwrap, runnerExecutable: runner };
});
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

test("aliases select one Node bundle without granting network or exposing an entire home", async () => {
  const sources = await resolveLocalTools(["node", "nvm", "npm", "npx"], home);
  expect(sources).toEqual([{ name: "node", sources: [] }]);
  const installed = join(home, ".nvm/versions/node/v22.1.0/bin");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "node"), '#!/bin/sh\nprintf fake-node', { mode: 0o755 });
  const node = (await resolveLocalTools(["node"], home))[0];
  expect(node.sources[0].source).toBe(join(home, ".nvm/versions/node/v22.1.0"));
  expect(node.sources[0].target).toEndWith("/v22.1.0");
});

test("generic tools include only their launcher/cache and a readable sourced updater", async () => {
  const [tool] = await resolveLocalTools(["sampleapp"], home);
  expect(tool.sources.map((entry) => entry.source)).toEqual([launcher, cache]);
  expect(tool.helper).toBe(helper);
  await expect(resolveLocalTools(["../sampleapp"], home)).rejects.toThrow("Invalid local tool name");
  await expect(resolveLocalTools(["wpscan"], home)).rejects.toThrow("external container engine");
  const alias = join(home, ".local/bin/samplealias");
  await symlink(launcher, alias);
  await expect(resolveLocalTools(["samplealias"], home)).rejects.toThrow("regular file");
  await chmod(launcher, 0o644);
  try { await expect(resolveLocalTools(["sampleapp"], home)).rejects.toThrow(); }
  finally { await chmod(launcher, 0o755); }
});

const run = async (command: string, enabled = true) => {
  const tools = enabled ? await resolveLocalTools(["sampleapp"], home) : [];
  const paths = tools.flatMap((tool) => [...tool.sources.map(({ source: path }) => ({ path, access: "read" as const })), ...(tool.helper ? [{ path: tool.helper, access: "read" as const }] : [])]);
  const scope = paths.length ? { paths } : undefined;
  const workspace = await validateWorkspace(project, native, [], scope, storage);
  workspace.localTools = tools;
  return executeIsolated({ tool: "bash", arguments: { command }, goal: "Test private tool updates", justification: "Disposable fixture", sandbox: scope }, workspace, native);
};

nativeTest("updates persist in private copies while installed code stays read-only and PATH grants expire", async () => {
  const first = await run(`sampleapp; test ! -w '${launcher}'; test ! -w '${cache}/marker'`);
  expect(first.isError).not.toBe(true);
  expect(JSON.stringify(first.content)).toContain("host-seed");
  expect(JSON.stringify((await run("sampleapp")).content)).toContain("private-update");
  expect(await readFile(join(cache, "marker"), "utf8")).toBe("host-seed");
  expect(JSON.stringify((await run("! command -v sampleapp && printf expired", false)).content)).toContain("expired");
});

nativeTest("tool bootstrap cannot follow planted launcher or storage symlinks", async () => {
  const victim = join(project, "victim"); await writeFile(victim, "unchanged");
  const copy = join(storage, "pi-tools/sampleapp/home/.local/bin/sampleapp");
  await run("sampleapp");
  await rm(copy); await symlink(victim, copy);
  expect((await run("sampleapp")).isError).not.toBe(true);
  expect(await readFile(victim, "utf8")).toBe("unchanged");
  const bin = join(storage, "pi-tools/sampleapp/home/.local/bin");
  await rm(bin, { recursive: true }); await symlink(project, bin);
  try { await expect(run("sampleapp")).rejects.toThrow("not a regular directory"); }
  finally { await rm(bin); }
  await access(victim);
});

nativeTest("Node installations cannot be combined with overlapping writable grants", async () => {
  const sources = (await resolveLocalTools(["node"]))[0].sources;
  expect(sources.length).toBeGreaterThan(0);
  for (const path of [sources[0].source, join(sources[0].source, "..")]) {
    await expect(validateWorkspace(project, native, [], { tools: ["node"], paths: [{ path, access: "write" }] }, storage)).rejects.toThrow("must remain read-only");
  }
});

nativeTest("the Node bundle also works with no host installation and remembers private version selection", async () => {
  const command = async (text: string) => {
    const workspace = await validateWorkspace(project, native, [], undefined, storage);
    workspace.localTools = [{ name: "node", sources: [] }];
    return executeIsolated({ tool: "bash", arguments: { command: text }, goal: "Test private Node selection", justification: "Disposable fixture" }, workspace, native);
  };
  expect((await command("nvm list")).isError).not.toBe(true);
  const prefix = "/tmp/pi-tools/node/versions/v22.1.0/bin";
  expect((await command(`mkdir -p ${prefix}; printf '#!/bin/sh\\nprintf fixture-node' > ${prefix}/node; chmod +x ${prefix}/node; nvm use 22`)).isError).not.toBe(true);
  const later = await command("nvm current; node --version");
  expect(later.isError).not.toBe(true);
  expect(JSON.stringify(later.content)).toContain("v22.1.0");
  expect(JSON.stringify(later.content)).toContain("fixture-node");
});
