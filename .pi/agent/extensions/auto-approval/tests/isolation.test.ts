import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectWorkspace, validateWorkspace, sandboxArguments, executeIsolated, type SandboxConfig } from "../isolation.ts";

const fixture = await mkdtemp(join(tmpdir(), "pi-isolation-test-"));
const home = join(fixture, "home");
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
};
beforeAll(async () => { await mkdir(home); git("init", "-q", home); });
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

test("non-repo children of a home dotfiles repository keep their own cwd", async () => {
  const cwd = join(home, "loose", "nested"); await mkdir(cwd, { recursive: true });
  expect(await detectWorkspace(cwd, home)).toEqual({ path: cwd, cwd });
  expect(await detectWorkspace(home, home)).toEqual({ path: home, cwd: home });
});
test("a project's own Git root is used without changing execution cwd", async () => {
  const root = join(home, "project"); const cwd = join(root, "src");
  await mkdir(cwd, { recursive: true }); git("init", "-q", root);
  expect(await detectWorkspace(cwd, home)).toEqual({ path: root, cwd });
});
test("Git roots above home do not enlarge a workspace", async () => {
  const outer = join(fixture, "outer"); const fakeHome = join(outer, "user"); const cwd = join(fakeHome, "loose");
  await mkdir(cwd, { recursive: true }); git("init", "-q", outer);
  expect(await detectWorkspace(cwd, fakeHome)).toEqual({ path: cwd, cwd });
});
test("no Git repository and symlinked cwd both resolve to the actual directory", async () => {
  const cwd = join(fixture, "plain"); const alias = join(fixture, "alias");
  await mkdir(cwd); await symlink(cwd, alias);
  expect(await detectWorkspace(alias, home)).toEqual({ path: cwd, cwd });
});

const bwrap = Bun.which("bwrap");
const nativeTest = process.platform === "linux" && bwrap ? test : test.skip;
let native: SandboxConfig;
let project: string;
beforeAll(async () => {
  if (!bwrap || process.platform !== "linux") return;
  const runner = join(fixture, "runner");
  const result = Bun.spawnSync([process.execPath, "build", "--compile", resolve(import.meta.dir, "../runner.ts"), "--outfile", runner], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  native = { backend: "bwrap", executable: bwrap, runnerExecutable: runner };
  project = join(fixture, "native-project"); await mkdir(project);
});
const action = (tool: string, args: Record<string, unknown>) => ({ tool, arguments: args, goal: "Sandbox integration test", justification: "Verify containment in a temporary test fixture" });
const run = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => executeIsolated(action(tool, args), await validateWorkspace(project, native, []), native, signal);

nativeTest("empty legacy workspaceRoots do not disable automatic detection", async () => {
  expect((await validateWorkspace(project, { ...native, workspaceRoots: [] }, [])).path).toBe(project);
});
nativeTest("real isolated writes, reads, edits, and ls persist only in the project", async () => {
  await run("write", { path: "allowed.txt", content: "before" });
  await run("edit", { path: "allowed.txt", edits: [{ oldText: "before", newText: "after" }] });
  expect(await readFile(join(project, "allowed.txt"), "utf8")).toBe("after");
  expect(JSON.stringify((await run("read", { path: "allowed.txt" })).content)).toContain("after");
  expect(JSON.stringify((await run("ls", { path: ".", limit: 100 })).content)).toContain("allowed.txt");
});
nativeTest("host secrets, environment, namespaces, and runner writes stay isolated", async () => {
  const secret = join(fixture, "host-secret.txt"); await writeFile(secret, "test-only-secret");
  process.env.PI_TEST_HOST_SECRET = "test-only-environment-value";
  try {
    const result = await run("bash", { command: `test ! -e '${secret}' && test -z "\${PI_TEST_HOST_SECRET+x}" && test ! -w /executor/runner && printf contained` });
    expect(JSON.stringify(result.content)).toContain("contained");
    const resultNs = await run("bash", { command: "readlink /proc/self/ns/net; readlink /proc/self/ns/pid" });
    const text = JSON.stringify(resultNs.content);
    const hostNetLink = await import("node:fs/promises").then((fs) => fs.readlink("/proc/self/ns/net"));
    const hostPidLink = await import("node:fs/promises").then((fs) => fs.readlink("/proc/self/ns/pid"));
    expect(text).not.toContain(hostNetLink); expect(text).not.toContain(hostPidLink);
  } finally { delete process.env.PI_TEST_HOST_SECRET; }
});
nativeTest("project-internal build hardlinks permit reads and edits", async () => {
  const artifact = join(project, "parser.wasm");
  const deps = join(project, "deps"); await mkdir(deps);
  const alias = join(deps, "parser.wasm");
  await writeFile(artifact, "build-output"); await link(artifact, alias);
  try {
    expect(JSON.stringify((await run("ls", { path: ".", limit: 100 })).content)).toContain("parser.wasm");
    expect(JSON.stringify((await run("read", { path: "parser.wasm" })).content)).toContain("build-output");
    await run("edit", { path: "parser.wasm", edits: [{ oldText: "build-output", newText: "updated-output" }] });
    expect(await readFile(alias, "utf8")).toBe("updated-output");
    // A file-only view does not expose the second link, so must not be writable.
    const projection = { ...native, backend: "bwrap", workspaceViews: [{ root: project, paths: [artifact] }] } as SandboxConfig;
    await expect(validateWorkspace(project, projection, [])).rejects.toThrow("hardlink has aliases outside");
    await expect(validateWorkspace(project, native, [deps])).rejects.toThrow("hardlink has aliases outside");
  } finally { await rm(artifact); await rm(deps, { recursive: true }); }
});
nativeTest("escaping symlinks and host hardlinks are rejected before execution", async () => {
  const outside = join(fixture, "outside.txt"); await writeFile(outside, "private");
  const alias = join(project, "escape"); await symlink(outside, alias);
  await expect(validateWorkspace(project, native, [])).rejects.toThrow("symlink escapes");
  await rm(alias); await link(outside, alias);
  await expect(validateWorkspace(project, native, [])).rejects.toThrow("hardlink");
  await rm(alias);
});
nativeTest("dangling build-cache symlinks do not block unrelated project actions", async () => {
  const broken = join(project, "stale-cache-link");
  await symlink(join(project, "removed-cache-result.json"), broken);
  try {
    // Pi's normal ls omits dangling symlink entries; the operation must still run.
    await run("ls", { path: ".", limit: 100 });
    await run("write", { path: "unrelated.txt", content: "still usable" });
    expect(await readFile(join(project, "unrelated.txt"), "utf8")).toBe("still usable");
  } finally { await rm(broken, { force: true }); await rm(join(project, "unrelated.txt"), { force: true }); }
});
nativeTest("protected descendants are masked instead of exposing credentials", async () => {
  const hidden = join(project, "private"); await mkdir(hidden); await writeFile(join(hidden, "token"), "private");
  const w = await validateWorkspace(project, native, [hidden]);
  const result = await executeIsolated(action("bash", { command: "test ! -r private/token && printf hidden" }), w, native);
  expect(JSON.stringify(result.content)).toContain("hidden");
  await expect(validateWorkspace(hidden, native, [hidden])).rejects.toThrow("inside protected");
  await rm(hidden, { recursive: true });
});
nativeTest("an exact-file projection cannot expose siblings or create persistent root files", async () => {
  const publicFile = join(project, "public.txt"); await writeFile(publicFile, "public");
  const c: SandboxConfig = { ...native, backend: "bwrap", workspaceViews: [{ root: project, paths: [publicFile] }] } as SandboxConfig;
  const w = await validateWorkspace(project, c, []);
  expect(w.bindings).toEqual([publicFile]);
  const result = await executeIsolated(action("bash", { command: "cat public.txt; test ! -e allowed.txt; test ! -w . && printf restricted" }), w, c);
  expect(JSON.stringify(result.content)).toContain("restricted");
  await executeIsolated(action("write", { path: "public.txt", content: "updated" }), w, c);
  await executeIsolated(action("edit", { path: "public.txt", edits: [{ oldText: "updated", newText: "edited" }] }), w, c);
  expect(await readFile(publicFile, "utf8")).toBe("edited");
});
nativeTest("sandbox failure has no unsandboxed fallback", async () => {
  const broken = { ...native, backend: "bwrap", executable: "/bin/false" } as SandboxConfig;
  const request = action("write", { path: "must-not-exist", content: "bad" });
  await expect(executeIsolated(request, await validateWorkspace(project, broken, []), broken)).rejects.toThrow("no local fallback");
  await expect(access(join(project, "must-not-exist"))).rejects.toThrow();
});
nativeTest("cancellation kills the isolated process without a late write", async () => {
  const controller = new AbortController();
  const pending = run("bash", { command: "sleep 10; touch cancelled" }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try { await expect(pending).rejects.toThrow("cancelled"); }
  finally { clearTimeout(timer); }
  await expect(access(join(project, "cancelled"))).rejects.toThrow();
});
nativeTest("detached descendants cannot write after their action has finished", async () => {
  await run("bash", { command: "sh -c 'sleep 0.3; touch escaped-background' </dev/null >/dev/null 2>&1 &" });
  await Bun.sleep(500);
  await expect(access(join(project, "escaped-background"))).rejects.toThrow();
});
