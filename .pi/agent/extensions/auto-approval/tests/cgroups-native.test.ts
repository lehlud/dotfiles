// Run only inside a disposable container with a delegated private cgroup subtree.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { executeIsolated, validateWorkspace, type SandboxConfig } from "../isolation.ts";
import { createCgroupScope } from "../sandbox/cgroup-scope.ts";
import type { Request } from "../../shared/contracts/action.ts";

const root = process.env.PI_CGROUP_TEST_ROOT;
const native = root ? test : test.skip;
let fixture: string;
let project: string;
let config: SandboxConfig;

beforeAll(async () => {
  if (!root) return;

  fixture = await mkdtemp(join(tmpdir(), "pi-cgroup-native-"));
  project = join(fixture, "project");
  await mkdir(project);

  const runner = join(fixture, "runner");
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      resolve(import.meta.dir, "../runner.ts"),
      "--outfile",
      runner,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (built.exitCode) throw new Error(built.stderr.toString());

  config = {
    backend: "bwrap",
    executable: "/usr/bin/bwrap",
    runnerExecutable: runner,
    cgroupRoot: root,
  };
});

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

const request = (command: string, limits = { memoryMiB: 256, cpus: 1, pids: 64 }): Request => ({
  tool: "bash",
  arguments: { command, timeout: 15 },
  sandbox: { limits },
  goal: "Verify isolated aggregate resource enforcement",
  justification: "Bounded synthetic kernel-controller test",
});
const run = async (action: Request, signal?: AbortSignal) =>
  executeIsolated(
    action,
    await validateWorkspace(project, config, [], action.sandbox),
    config,
    signal,
  );

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;

    await delay(10);
  }

  throw new Error("Timed out waiting for bounded cgroup fixture");
}

native(
  "limits are installed before payload execution and controller mounts stay hidden",
  async () => {
    const action = request(
      "test ! -e /sys/fs/cgroup && printf started > ready; sleep 3; printf hidden",
    );
    const pending = run(action);

    await waitFor(() =>
      access(join(project, "ready")).then(
        () => true,
        () => false,
      ),
    );

    const groups = await readdir(root!);
    const path = join(root!, groups.find((name) => name.startsWith("pi-action-"))!);

    expect((await readFile(join(path, "memory.max"), "utf8")).trim()).toBe("268435456");
    expect((await readFile(join(path, "cpu.max"), "utf8")).trim()).toBe("100000 100000");
    expect((await readFile(join(path, "pids.max"), "utf8")).trim()).toBe("64");
    expect((await readFile(join(path, "cgroup.procs"), "utf8")).split(/\s/u)).not.toContain(
      String(process.pid),
    );
    expect(JSON.stringify((await pending).content)).toContain("hidden");
    expect((await readdir(root!)).filter((name) => name.startsWith("pi-action-"))).toEqual([]);
  },
);

native("aggregate memory exhaustion kills the action without killing its supervisor", async () => {
  const code = `import subprocess, sys
children = []
for index in range(3):
    children.append(subprocess.Popen([sys.executable, '-c', 'import time; data=bytearray(96*1024*1024); data[::4096]=b"x"*len(data[::4096]); time.sleep(10)']))
for child in children:
    child.wait()
`;

  await expect(run(request(`python3 - <<'PY'\n${code}PY`))).rejects.toThrow(
    "aggregate cgroup memory limit",
  );
  expect((await readdir(root!)).filter((name) => name.startsWith("pi-action-"))).toEqual([]);
});

native("PID limits count descendants and block a bounded fork attempt", async () => {
  const code = `import errno, os, signal, time
children = []
blocked = False
try:
    for index in range(80):
        try:
            pid = os.fork()
        except OSError as error:
            if error.errno != errno.EAGAIN: raise
            blocked = True
            break
        if pid == 0:
            time.sleep(10)
            os._exit(0)
        children.append(pid)
    print('PID_LIMIT_BLOCKED' if blocked else 'UNENFORCED', len(children))
finally:
    for pid in children: os.kill(pid, signal.SIGKILL)
    for pid in children: os.waitpid(pid, 0)
`;

  expect(JSON.stringify((await run(request(`python3 - <<'PY'\n${code}PY`))).content)).toContain(
    "PID_LIMIT_BLOCKED",
  );
});

native("CPU quota actually throttles the action", async () => {
  const action = request(
    "python3 -c 'import time; end=time.monotonic()+3; exec(\"while time.monotonic()<end: pass\")'",
    { memoryMiB: 256, cpus: 0.1, pids: 64 },
  );
  const pending = run(action);

  await waitFor(async () => {
    const group = (await readdir(root!)).find((name) => name.startsWith("pi-action-"));

    if (!group) return false;

    const stats = await readFile(join(root!, group, "cpu.stat"), "utf8");

    return /^nr_throttled [1-9]/mu.test(stats);
  });
  expect((await pending).isError).not.toBe(true);
});

native("cancellation drains the action cgroup and preserves the supervisor", async () => {
  const controller = new AbortController();
  const pending = run(request("printf ready > cancel-ready; sleep 10"), controller.signal).then(
    () => undefined,
    (error: Error) => error,
  );

  await waitFor(() =>
    access(join(project, "cancel-ready")).then(
      () => true,
      () => false,
    ),
  );
  controller.abort();
  expect((await pending)?.message).toContain("cancelled");
  expect((await readdir(root!)).filter((name) => name.startsWith("pi-action-"))).toEqual([]);
});

native("changed review plans and controller grants fail before executing anything", async () => {
  const action = request("printf must-not-run");
  const workspace = await validateWorkspace(project, config, [], action.sandbox);

  await expect(
    createCgroupScope(config, { ...workspace, cgroup: undefined }, action.sandbox),
  ).rejects.toThrow("changed after independent review");
  await expect(
    executeIsolated(action, { ...workspace, bindings: [project, root!] }, config),
  ).rejects.toThrow("Cgroup controller files");
  expect((await readdir(root!)).filter((name) => name.startsWith("pi-action-"))).toEqual([]);
});

native("cancelling one concurrent action leaves its peer and supervisor running", async () => {
  const membership = await readFile("/proc/self/cgroup", "utf8");
  const controller = new AbortController();
  const first = run(request("printf ready > first-ready; sleep 10"), controller.signal).then(
    () => undefined,
    (error: Error) => error,
  );
  const second = run(request("printf ready > second-ready; sleep 2; printf peer-survived"));

  await waitFor(() =>
    Promise.all(
      ["first-ready", "second-ready"].map((name) =>
        access(join(project, name)).then(
          () => true,
          () => false,
        ),
      ),
    ).then((found) => found.every(Boolean)),
  );
  expect((await readdir(root!)).filter((name) => name.startsWith("pi-action-"))).toHaveLength(2);
  controller.abort();
  expect((await first)?.message).toContain("cancelled");
  expect(JSON.stringify((await second).content)).toContain("peer-survived");
  expect(await readFile("/proc/self/cgroup", "utf8")).toBe(membership);
  expect((await readdir(root!)).filter((name) => name.startsWith("pi-action-"))).toEqual([]);
});
