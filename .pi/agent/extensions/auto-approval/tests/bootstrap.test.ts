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
  await mkdir(join(source, "../web-research"), { recursive: true });
  for (const name of ["index.ts", "execute.ts", "package.json", "bun.lock"]) await copyFile(join(import.meta.dir, "../../web-research", name), join(source, "../web-research", name));
  await mkdir(join(source, "../public-writing"), { recursive: true });
  for (const name of ["index.ts", "rules.ts", "package.json", "bun.lock"]) await copyFile(join(import.meta.dir, "../../public-writing", name), join(source, "../public-writing", name));
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

test("startup rebuilds compiled web code after an extension update", async () => {
  await writeFile(join(agent, "auto-approval.json"), JSON.stringify(portable));
  await writeFile(join(agent, "auto-approval.device.json"), JSON.stringify({ sandbox: { executable: process.execPath } }));
  const web = join(source, "../web-research/execute.ts");
  await writeFile(web, 'export const fixture = "first web implementation";\n');
  await writeFile(join(source, "runner.ts"), 'import { fixture } from "../web-research/execute.ts"; console.log(fixture);\n');
  await prepareExecutor(source, home, agent);
  expect(Bun.spawnSync([runner]).stdout.toString()).toContain("first web implementation");
  await writeFile(web, 'export const fixture = "updated web implementation";\n');
  await prepareExecutor(source, home, agent);
  expect(Bun.spawnSync([runner]).stdout.toString()).toContain("updated web implementation");
});

test("a frozen editorial-rule change rebuilds the native executor", async () => {
  const rules = join(source, "../public-writing/rules.ts");
  const original = await readFile(rules, "utf8");
  await writeFile(rules, `${original}\nexport const fixture = "first editorial rules";\n`);
  await writeFile(join(source, "runner.ts"), 'import { fixture } from "../public-writing/rules.ts"; console.log(fixture);\n');
  await prepareExecutor(source, home, agent);
  expect(Bun.spawnSync([runner]).stdout.toString()).toContain("first editorial rules");
  await writeFile(rules, `${original}\nexport const fixture = "updated editorial rules";\n`);
  await prepareExecutor(source, home, agent);
  expect(Bun.spawnSync([runner]).stdout.toString()).toContain("updated editorial rules");
});

test("Docker startup leaves the native executor untouched", async () => {
  await writeFile(join(agent, "auto-approval.json"), JSON.stringify({ ...portable, sandbox: { backend: "docker", image: `sha256:${"a".repeat(64)}` } }));
  await writeFile(join(agent, "auto-approval.device.json"), JSON.stringify({ sandbox: { dockerExecutable: "/custom/docker" } }));
  const before = await stat(runner);
  await prepareExecutor(source, home, agent);
  expect((await stat(runner)).ino).toBe(before.ino);
});
