import { test, expect, beforeAll, afterAll } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareExecutor } from "../bootstrap.ts";

const fixture = await mkdtemp(join(tmpdir(), "pi-bootstrap-test-"));
const home = join(fixture, "home");
const agent = join(home, ".pi", "agent");
const source = join(agent, "extensions", "auto-approval");
const runner = join(home, ".local", "cache", "pi-auto-approval", "executor");
const portable = { reviewers: [{ provider: "openai", model: "gpt-6-luna", thinking: "medium" }], recentUserPrompts: 6, requestTimeoutMs: 120000, sandbox: { backend: "bwrap" } };
beforeAll(async () => {
  await mkdir(source, { recursive: true });
  for (const name of ["package.json", "bun.lock", "config.ts", "policy.ts"]) await copyFile(join(import.meta.dir, "..", name), join(source, name));
  await writeFile(join(source, "runner.ts"), 'console.log("first executor");\n');
  await writeFile(join(agent, "auto-approval.json"), JSON.stringify(portable));
  await writeFile(join(agent, "auto-approval.device.json"), JSON.stringify({ sandbox: { executable: process.execPath } }));
});
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

test("startup installs dependencies, rebuilds missing or changed executors, and preserves a good binary on build failure", async () => {
  await prepareExecutor(source, home, agent);
  expect(Bun.spawnSync([runner]).stdout.toString()).toContain("first executor");
  const initial = await stat(runner);
  await prepareExecutor(source, home, agent);
  expect((await stat(runner)).ino).toBe(initial.ino);
  expect((await stat(runner)).mtimeMs).toBe(initial.mtimeMs);
  await writeFile(join(source, "runner.ts"), 'console.log("second executor");\n');
  await prepareExecutor(source, home, agent);
  expect(Bun.spawnSync([runner]).stdout.toString()).toContain("second executor");
  await rm(runner);
  await prepareExecutor(source, home, agent);
  expect(Bun.spawnSync([runner]).stdout.toString()).toContain("second executor");
  const beforeFailure = await readFile(`${runner}.sources.sha256`, "utf8");
  await writeFile(join(source, "runner.ts"), 'import "missing-bootstrap-test-dependency";\n');
  await expect(prepareExecutor(source, home, agent)).rejects.toThrow("setup failed");
  expect(await readFile(`${runner}.sources.sha256`, "utf8")).toBe(beforeFailure);
  expect(Bun.spawnSync([runner]).stdout.toString()).toContain("second executor");
});

test("startup validates custom executors without overwriting them", async () => {
  const custom = join(fixture, "custom-runner");
  const local = join(agent, "auto-approval.device.json");
  await writeFile(local, JSON.stringify({ sandbox: { executable: process.execPath, runnerExecutable: custom } }));
  await expect(prepareExecutor(source, home, agent)).rejects.toThrow(`Sandbox executable unavailable: ${custom}`);
  await writeFile(custom, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await prepareExecutor(source, home, agent);
  expect(await readFile(custom, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  await rm(local);
});

test("Docker startup leaves the native executor untouched", async () => {
  await writeFile(join(agent, "auto-approval.json"), JSON.stringify({ ...portable, sandbox: { backend: "docker", image: `sha256:${"a".repeat(64)}` } }));
  await writeFile(join(agent, "auto-approval.device.json"), JSON.stringify({ sandbox: { dockerExecutable: "/custom/docker" } }));
  const before = await stat(runner);
  await prepareExecutor(source, home, agent);
  expect((await stat(runner)).ino).toBe(before.ino);
});
