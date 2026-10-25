import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { JobManager } from "../../jobs/manager.ts";
import jobs from "../../jobs/index.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { reviewedReceipts } from "../../shared/review/receipts.ts";

const spec = {
  title: "Validation",
  work: "Review the independent documentation changes",
  toolCallId: "command",
};
const result = {
  content: [{ type: "text" as const, text: "validation output" }],
  details: { exitCode: 0 },
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function fixture() {
  const events: any[] = [];
  const manager = new JobManager({
    started: (job) => events.push(["start", job]),
    completed: (job, output) => events.push(["complete", job, output]),
    notify: (job, output) => events.push(["notify", job, output]),
    changed() {},
    error: (error) => events.push(["error", error]),
  });

  return { manager, events };
}

test("jobs admit durably, return before execution, and deliver completion once", async () => {
  const { manager, events } = fixture();
  const release = deferred();
  let executed = false;
  const job = manager.start(spec, async () => {
    executed = true;
    await release.promise;

    return result;
  });

  expect(executed).toBe(false);
  expect(events.map(([kind]) => kind)).toEqual(["start"]);
  await Promise.resolve();
  expect(executed).toBe(true);
  expect(manager.busy).toBe(true);
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(manager.busy).toBe(false);
  expect(manager.revision).toBe(2);
  expect(events.map(([kind]) => kind)).toEqual(["start", "complete", "notify"]);
  expect(events.at(-1)[1].id).toBe(job.id);
  await manager.stop();
  expect(events.filter(([kind]) => kind === "notify")).toHaveLength(1);
});

test("join waits for the real result without timers or duplicate completion delivery", async () => {
  const { manager, events } = fixture();
  const release = deferred();
  const job = manager.start(spec, async () => {
    await release.promise;

    return result;
  });
  let returned = false;
  const waiting = manager.wait(job.id).then((results) => {
    returned = true;

    return results;
  });

  await Promise.resolve();
  expect(returned).toBe(false);
  release.resolve();
  expect((await waiting)[0].result).toEqual(result);
  expect(events.filter(([kind]) => kind === "notify")).toHaveLength(0);
  await expect(manager.wait(undefined)).rejects.toThrow("instead of polling");
});

test("an interrupted join leaves execution owned and completion still arrives", async () => {
  const { manager, events } = fixture();
  const release = deferred();
  const job = manager.start(spec, async () => {
    await release.promise;

    return result;
  });
  const controller = new AbortController();
  const waiting = manager.wait(job.id, controller.signal);

  controller.abort(new Error("steering"));
  await expect(waiting).rejects.toThrow("steering");
  expect(manager.busy).toBe(true);
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events.filter(([kind]) => kind === "notify")).toHaveLength(1);
});

test("sleep uses a timer, wakes on completion, and aborts without leaving a timer", async () => {
  const { manager } = fixture();
  const start = Date.now();

  expect(await manager.sleep(0.02)).toContain("elapsed");
  expect(Date.now() - start).toBeGreaterThanOrEqual(15);

  const release = deferred();
  const job = manager.start(spec, async () => {
    await release.promise;

    return result;
  });
  const sleeping = manager.sleep(3600);

  release.resolve();
  expect(await sleeping).toContain("Job activity");

  const controller = new AbortController();
  const interrupted = manager.sleep(3600, controller.signal);

  controller.abort(new Error("user input"));
  await expect(interrupted).rejects.toThrow("user input");
  expect((await manager.wait(job.id))[0].job.state).toBe("succeeded");
});

test("interrupt waits for cleanup, blocks late admission, stays silent and permits explicit resume", async () => {
  const { manager, events } = fixture();
  const cleanup = deferred();
  let aborted = false;

  manager.start(spec, async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      );
    });
    await cleanup.promise;

    return result;
  });
  await Promise.resolve();

  let stopped = false;
  const stop = manager.cancelAll().then(() => {
    stopped = true;
  });

  expect(aborted).toBe(true);
  expect(stopped).toBe(false);
  expect(() => manager.start(spec, async () => result)).toThrow("interrupted");
  cleanup.resolve();
  await stop;
  expect(events.filter(([kind]) => kind === "notify")).toHaveLength(0);
  expect(events.find(([kind]) => kind === "complete")[2].isError).toBe(true);
  await manager.resume();

  const next = manager.start(spec, async () => result);

  await manager.wait(next.id);
  await manager.stop();
  await manager.resume();
  expect(() => manager.start(spec, async () => result)).toThrow("closing");
});

test("start audit failure never launches, and completion audit failure cannot report success", async () => {
  let ran = false;
  const manager = new JobManager({
    started() {
      throw new Error("disk full");
    },
    completed() {},
    notify() {},
    changed() {},
    error() {},
  });

  expect(() =>
    manager.start(spec, async () => {
      ran = true;

      return result;
    }),
  ).toThrow("disk full");
  await Promise.resolve();
  expect(ran).toBe(false);

  const failed = new JobManager({
    started() {},
    completed() {
      throw new Error("disk full");
    },
    notify() {},
    changed() {},
    error() {},
  });
  const job = failed.start(spec, async () => result);
  const results = await failed.wait(job.id);

  expect(results[0].job.state).toBe("failed");
  expect(results[0].result.isError).toBe(true);
});

test("job capacity and identity are session-local; settled result storage stays bounded", async () => {
  const { manager } = fixture();
  const other = fixture().manager;
  const release = deferred();
  const active = Array.from({ length: 4 }, () =>
    manager.start(spec, async () => {
      await release.promise;

      return result;
    }),
  );

  expect(() => manager.start(spec, async () => result)).toThrow("Four background jobs");
  await expect(other.cancel(active[0].id)).rejects.toThrow("Unknown job");
  release.resolve();
  await manager.wait(undefined);

  for (let i = 0; i < 40; i++) await manager.wait(manager.start(spec, async () => result).id);

  expect(manager.list().length).toBeLessThanOrEqual(32);
  await manager.stop();
});

test("the tool has no launch/status/poll capability and steering wakes a pending sleep", async () => {
  const hooks: Record<string, Function> = {};
  let tool: any;
  const ctx: any = { sessionManager: {}, mode: "json", ui: { setStatus() {}, notify() {} } };
  const pi: any = {
    on: (name: string, hook: Function) => {
      hooks[name] = hook;
    },
    registerTool: (value: any) => {
      tool = value;
    },
    registerCommand() {},
    registerMessageRenderer() {},
    appendEntry() {},
    sendMessage() {},
  };

  jobs(pi);
  hooks.session_start({}, ctx);
  expect(Check(tool.parameters, { operation: "status" })).toBe(false);
  expect(tool.parameters.type).toBe("object");
  await expect(tool.execute("bad", { operation: "wait", seconds: 5 })).rejects.toThrow(
    "Invalid job operation",
  );
  expect(Check(tool.parameters, { operation: "sleep", seconds: 0 })).toBe(false);

  const sleeping = tool.execute("sleep", { operation: "sleep", seconds: 3600 });

  hooks.input({ source: "interactive", text: "new detail" });
  await expect(sleeping).rejects.toThrow("User input arrived");
  expect(sessionServices(ctx).jobs).toBeDefined();
  await hooks.session_shutdown({}, ctx);
});

test("only completed background command output becomes trusted action evidence", () => {
  const audit = {
    decision: "approve",
    toolCallId: "command",
    requestId: "review",
    fingerprint: "hash",
    action: {
      tool: "bash",
      arguments: { command: "test" },
      background: { title: "test", work: "review docs" },
    },
  };
  const start = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "approved_action",
      toolCallId: "command",
      content: [{ type: "text", text: "started" }],
      details: { approval: audit, backgroundJob: { id: "job" } },
    },
  };
  const message = {
    role: "toolResult",
    toolName: "approved_action",
    toolCallId: "command",
    content: [
      { type: "text", text: "approved" },
      { type: "text", text: "real output" },
    ],
    details: { approval: audit, result: { exitCode: 0 } },
  };
  const entries: any[] = [
    { type: "custom", customType: "auto-approval-review", data: audit },
    start,
  ];

  expect(reviewedReceipts(entries)).toHaveLength(0);
  expect(
    reviewedReceipts([
      ...entries,
      { type: "message", message: { role: "custom", content: JSON.stringify(message) } },
    ]),
  ).toHaveLength(0);
  expect(
    reviewedReceipts([
      ...entries,
      { type: "custom", customType: "auto-approval-job-result", data: { message } },
    ])[0].content,
  ).toEqual([{ type: "text", text: "real output" }]);
  expect(
    reviewedReceipts([
      ...entries,
      {
        type: "custom",
        customType: "auto-approval-job-result",
        data: { message: { ...message, isError: true } },
      },
    ]),
  ).toHaveLength(0);
});
