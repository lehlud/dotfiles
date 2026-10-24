import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Quiescence } from "../../multiplex/quiescence.ts";
import { Coordination } from "../../multiplex/coordination.ts";
import { watchInterrupt, watchRpcAbort } from "../../multiplex/interrupt.ts";

const split = [
  { name: "otter", task: "Inspect roadmap and repository once", resources: ["discovery"] },
  { name: "maple", task: "Wait for discovery findings", resources: [] as string[], waiting: true },
];

test("all members must agree one exact split before discovery; waiting members cannot duplicate work", () => {
  const changes: boolean[] = [],
    board = new Coordination(["otter", "maple"], (ready) => changes.push(ready));

  expect(() => board.acquire("otter")).toThrow("agree one work split");

  const plan = board.propose("otter", split);

  expect(plan.accepted).toEqual(["otter"]);
  expect(board.ready).toBe(false);
  expect(() => board.acquire("otter")).toThrow("agree one work split");
  expect(() => board.accept("maple", "stale")).toThrow("stale");
  board.accept("maple", plan.id!);
  expect(changes).toEqual([false, true]);
  board.accept("maple", plan.id!);
  expect(changes).toEqual([false, true]);
  expect(() => board.acquire("maple")).toThrow("waiting");

  const lease = board.acquire("otter");

  expect(() => board.propose("maple", split)).toThrow("current external actions");
  expect(() => board.withdraw("maple", plan.id!)).toThrow("current external actions");
  lease.release();
  lease.release();
  board.withdraw("maple", plan.id!);
  expect(() => lease.assertCurrent()).toThrow("agree one work split");

  const next = board.propose("maple", split);

  expect(next.accepted).toEqual(["maple"]);
  board.close();
  expect(() => board.accept("otter", next.id!)).toThrow("inactive");
});

test("ownership rejects duplicate tasks, subtree overlap, missing actors, impersonation and traversal", () => {
  const board = new Coordination(["otter", "maple"]);

  expect(() => board.propose("forged", split)).toThrow("unknown");
  expect(() => board.propose("otter", [split[0]])).toThrow("every member");
  expect(() =>
    board.propose("otter", [split[0], { ...split[1], task: split[0].task.toUpperCase() }]),
  ).toThrow("distinct");
  expect(() =>
    board.propose("otter", [
      { ...split[0], resources: ["src"] },
      { ...split[1], waiting: false, resources: ["src/parser"] },
    ]),
  ).toThrow("overlaps");
  expect(() =>
    board.propose("otter", [
      { ...split[0], resources: ["./src/"] },
      { ...split[1], waiting: false, resources: ["src"] },
    ]),
  ).toThrow("overlaps");
  expect(() =>
    board.propose("otter", [{ ...split[0], resources: ["../outside"] }, split[1]]),
  ).toThrow("traversal");
  expect(() => board.propose("otter", [{ ...split[0], resources: [] }, split[1]])).toThrow(
    "ownership",
  );
  board.propose("otter", split);
  expect(() => board.propose("maple", split)).toThrow("awaiting acceptance");
  expect(board.describe()).toContain("maple: Wait for discovery findings");
});

test("RPC interrupt observes split/coalesced commands, skips large prompts and detaches without consuming input", () => {
  const input = new PassThrough(),
    original: string[] = [];
  let aborts = 0;

  input.on("data", (chunk) => original.push(chunk.toString()));

  const detach = watchRpcAbort(input, () => aborts++);

  input.write('{"type":"prompt","message":"abort"}\n{"ty');
  input.write('pe":"abort"}\n');
  input.write('{"type":"prompt","message":"' + "x".repeat(8000));
  input.write('"}\n{"type":"abort","id":"two"}\n');
  input.write('invalid\n{"type":"abort"}\n');
  expect(aborts).toBe(3);
  expect(original.join("")).toContain("x".repeat(8000));
  detach();
  input.write('{"type":"abort"}\n');
  expect(aborts).toBe(3);
  expect(input.listenerCount("data")).toBe(1);
  input.destroy();
});

test("Escape interrupts the team even when its terminal actor is idle and removes its listener", async () => {
  let listener: any,
    active = true,
    calls = 0,
    removed = false;
  const ctx: any = {
    mode: "tui",
    sessionManager: {},
    isIdle: () => true,
    ui: {
      onTerminalInput(handler: any) {
        listener = handler;

        return () => {
          removed = true;
        };
      },

      notify() {},
    },
  };
  const detach = watchInterrupt(
    ctx,
    () => active,
    async () => {
      calls++;
      active = false;
    },
  );

  expect(listener("ordinary input")).toBeUndefined();
  expect(listener("\x1b")).toEqual({ consume: true });
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(listener("\x1b")).toBeUndefined();
  detach();
  expect(removed).toBe(true);
});

test("idle goal recovery batches unread mail without repeated wakes, polls or premature checkpoints", () => {
  const scheduler = new Quiescence(),
    woke: string[] = [];
  let checks = 0;
  const wake = (name: string) => woke.push(name),
    check = () => checks++;
  const unread = [
    { name: "jay", sequence: 45 },
    { name: "raven", sequence: 46 },
  ];

  scheduler.settle(undefined, 10, unread, wake, check);
  expect(woke).toEqual([]);
  expect(checks).toBe(0);
  scheduler.settle("goal-1", 10, unread, wake, check);
  expect(woke).toEqual(["jay", "raven"]);
  expect(checks).toBe(0);

  for (let i = 0; i < 20; i++) scheduler.settle("goal-1", 10, unread, wake, check);

  expect(woke).toHaveLength(2);
  expect(checks).toBe(0);
  scheduler.settle("goal-1", 11, [{ name: "jay", sequence: 47 }], wake, check);
  expect(woke).toEqual(["jay", "raven", "jay"]);
  scheduler.settle("goal-1", 11, [], wake, check);

  for (let i = 0; i < 20; i++) scheduler.settle("goal-1", 11, [], wake, check);

  expect(checks).toBe(1);
  // Reviewed tool progress requires a fresh checkpoint even with no final reply.
  scheduler.settle("goal-1", 12, [], wake, check);
  expect(checks).toBe(2);
  scheduler.settle(undefined, 13, [{ name: "jay", sequence: 48 }], wake, check);
  expect(woke).toHaveLength(3);
  expect(checks).toBe(2);
  scheduler.settle("goal-2", 13, [{ name: "jay", sequence: 47 }], wake, check);
  expect(woke).toHaveLength(4);
});
