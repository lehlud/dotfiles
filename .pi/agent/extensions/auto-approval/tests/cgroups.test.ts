import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cgroupControls, planCgroup } from "../sandbox/cgroup-plan.ts";
import { parseLocalConfig, parseConfig } from "../../shared/configuration/schemas.ts";

const native = {
  backend: "bwrap" as const,
  executable: "/usr/bin/bwrap",
  runnerExecutable: "/executor",
};

test("aggregate limits map to kernel controls; unrelated limits require no cgroup", async () => {
  expect(cgroupControls({ memoryMiB: 256, cpus: 0.25, pids: 64 })).toEqual({
    "memory.max": "268435456",
    "memory.swap.max": "0",
    "memory.oom.group": "1",
    "cpu.max": "25000 100000",
    "pids.max": "64",
  });
  expect(await planCgroup(native, { executionTimeoutMs: 1000 })).toBeUndefined();

  for (const limits of [
    { cpus: NaN },
    { cpus: 0 },
    { pids: 1 },
    { pids: 64.5 },
    { memoryMiB: Infinity },
  ])
    expect(() => cgroupControls(limits)).toThrow("Invalid aggregate");
});

test("ordinary directories cannot impersonate kernel resource enforcement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-fake-cgroup-"));

  try {
    await expect(
      planCgroup({ ...native, cgroupRoot: join(directory, "missing") }, { memoryMiB: 256 }),
    ).rejects.toThrow("delegated cgroup v2 subtree");
    await expect(planCgroup({ ...native, cgroupRoot: directory }, { pids: 64 })).rejects.toThrow(
      "not a cgroup v2",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delegation is device-owned configuration, never a per-action or portable permission", () => {
  expect(
    parseLocalConfig('{"sandbox":{"cgroupRoot":"/sys/fs/cgroup/pi-actions"}}').sandbox?.cgroupRoot,
  ).toBe("/sys/fs/cgroup/pi-actions");
  expect(() => parseLocalConfig('{"sandbox":{"cgroupRoot":"relative"}}')).toThrow();
  expect(() =>
    parseConfig(
      JSON.stringify({
        reviewers: [{ provider: "openai", model: "gpt-6-luna", thinking: "medium" }],
        recentUserPrompts: 10,
        requestTimeoutMs: 10000,
        sandbox: { backend: "bwrap", cgroupRoot: "/sys/fs/cgroup/pi-actions" },
      }),
    ),
  ).toThrow();
});
