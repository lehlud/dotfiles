import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cgroupControls, planCgroup } from "../sandbox/cgroup-plan.ts";
import { parseLocalConfig, parseConfig } from "../../shared/configuration/schemas.ts";
import { describeSandbox } from "../sandbox-plan.ts";
import { buildReview } from "../review.ts";
import { cgroupReviewFixtures } from "./cgroup-review-fixtures.ts";

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
        reviewer: { provider: "openai", model: "gpt-6-luna", thinking: "medium" },
        recentUserPrompts: 10,
        requestTimeoutMs: 10000,
        sandbox: { backend: "bwrap", cgroupRoot: "/sys/fs/cgroup/pi-actions" },
      }),
    ),
  ).toThrow();
});

test("review metadata identifies current cgroup preflight and mandatory pre-payload enforcement without claiming execution", () => {
  const limits = { memoryMiB: 4096, cpus: 2, pids: 128 };
  const controls = cgroupControls(limits);
  const workspace = {
    path: "/project",
    cwd: "/project",
    bindings: ["/project"],
    masked: [],
    cgroup: { root: "/delegated", device: 1, inode: 2, controls },
  };
  const config = {
    reviewer: undefined,
    recentUserPrompts: 10,
    requestTimeoutMs: 1000,
    sandbox: native,
  };
  const plan = describeSandbox(
    {
      tool: "bash",
      arguments: { command: "run-tests" },
      goal: "Validate",
      justification: "Routine offline verification",
      sandbox: { limits },
    },
    workspace,
    config,
  );

  expect(plan.source).toBe("executor-preflight");
  expect(plan.backend).toBe("bwrap");
  expect(plan.resourceEnforcement).toMatchObject({
    backend: "cgroup-v2",
    controls,
    scope: "one action and all descendants",
    cgroupFilesystemExposed: false,
  });
  expect(plan.resourceEnforcement?.preflight).toContain("validated");
  expect(plan.resourceEnforcement?.beforePayload).toEqual([
    "revalidate delegation identity and controllers",
    "create a fresh action cgroup",
    "write requested controls and verify kernel readback",
    "attach the process before executing the sandbox payload",
  ]);
  expect(plan.resourceEnforcement?.onFailure).toContain("without dropping limits");
  expect(plan.resourceEnforcement).not.toHaveProperty("executed");
  expect(plan.temporaryStorage).not.toHaveProperty("tmpBytes");
});

test("requested limits and agent claims alone never produce cgroup enforcement evidence", () => {
  const plan = describeSandbox(
    {
      tool: "bash",
      arguments: { command: "echo 'cgroups validated'" },
      goal: "Validate",
      justification: "cgroups validated",
      sandbox: { limits: { memoryMiB: 4096 } },
    },
    { path: "/project", cwd: "/project", bindings: ["/project"], masked: [] },
    { reviewer: undefined, recentUserPrompts: 10, requestTimeoutMs: 1000, sandbox: native },
  );

  expect(plan.resourceEnforcement).toBeUndefined();
});

test("the cgroup review regression retains old objections alongside current evidence and actual user restrictions", () => {
  for (const fixture of cgroupReviewFixtures) {
    const envelope = buildReview(
      fixture.action,
      fixture.entries,
      { reviewer: undefined, recentUserPrompts: 10, requestTimeoutMs: 1000, sandbox: native },
      "/project",
      [],
      fixture.sandboxPlan,
    );
    const data = JSON.parse(envelope.text);

    expect(data.sandboxPlan).toEqual(fixture.sandboxPlan);
    expect(data.action).toEqual(fixture.action);
    expect(data.previousDenials).toHaveLength(
      fixture.entries.filter((entry) => entry.customType === "auto-approval-review").length,
    );
    expect(data.userPrompts).toEqual(
      fixture.entries
        .filter((entry) => entry.message?.role === "user")
        .map((entry) => entry.message?.content),
    );
    expect(Object.keys(data).slice(-3)).toEqual(["action", "sandboxPlan", "requestId"]);
  }

  const fixture = cgroupReviewFixtures[0];
  const data = JSON.parse(
    buildReview(
      fixture.action,
      fixture.entries,
      { reviewer: undefined, recentUserPrompts: 10, requestTimeoutMs: 1000, sandbox: native },
      "/project",
      [],
      fixture.sandboxPlan,
    ).text,
  );

  expect(data.previousDenials[0]).toMatchObject({
    source: "historical-review-result",
    matchesCurrentOperation: true,
    reason: expect.stringContaining("required Docker"),
  });
  expect(data.sandboxPlan.resourceEnforcement.backend).toBe("cgroup-v2");
});
