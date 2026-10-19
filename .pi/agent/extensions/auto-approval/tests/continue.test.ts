import { expect, test } from "bun:test";
import { registerContinue, CONTINUE_INSTRUCTION } from "../../conversations/continue.ts";
import { sessionServices } from "../../shared/session/services.ts";

function fixture() {
  let command: any;
  const sent: any[] = [];
  const notices: string[] = [];
  const ctx = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: {},
    modelRegistry: { hasConfiguredAuth: () => true },
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "user", content: "Original task" } }],
    },
    ui: { notify: (text: string) => notices.push(text) },
  };

  registerContinue({
    registerCommand: (name: string, definition: any) => {
      expect(name).toBe("continue");
      command = definition.handler;
    },

    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  } as any);

  return { ctx, sent, notices, run: (args = "") => command(args, ctx) };
}

test("continuation preserves operator context, broadcasts once and resets progress", async () => {
  const state = fixture();
  const team: string[] = [];
  let resets = 0;
  const services = sessionServices(state.ctx as any);

  services.continueTeam = (content) => {
    team.push(content);
  };

  services.resetProgress = () => {
    resets++;
  };

  await state.run();
  expect(team).toEqual([CONTINUE_INSTRUCTION]);
  expect(resets).toBe(1);
  expect(state.sent).toEqual([
    {
      message: {
        customType: "conversation-continuation",
        display: false,
        content: CONTINUE_INSTRUCTION,
      },
      options: { triggerTurn: true },
    },
  ]);
  expect(CONTINUE_INSTRUCTION).toContain("Preserve actual operator constraints");
  expect(CONTINUE_INSTRUCTION).toContain("never execute a denied request without fresh approval");
});

test("paused goals use their own resume service without sending a second instruction", async () => {
  const state = fixture();
  let resumed = 0;

  sessionServices(state.ctx as any).resumeGoal = async (ctx) => {
    expect(Object.is(ctx, state.ctx)).toBe(true);
    resumed++;

    return true;
  };

  await state.run();
  expect(resumed).toBe(1);
  expect(state.sent).toEqual([]);
});

test("running work, queued input, absent authentication and arguments do not start a run", async () => {
  for (const kind of ["busy", "queued", "authentication", "arguments"]) {
    const state = fixture();

    if (kind === "busy") state.ctx.isIdle = () => false;

    if (kind === "queued") state.ctx.hasPendingMessages = () => true;

    if (kind === "authentication") state.ctx.modelRegistry.hasConfiguredAuth = () => false;

    await state.run(kind === "arguments" ? "new task" : "");
    expect(state.sent).toEqual([]);
    expect(state.notices).toHaveLength(1);
  }
});

test("empty history and busy teams fail before a continuation starts", async () => {
  const empty = fixture();

  empty.ctx.sessionManager.getBranch = () => [];
  await empty.run();
  expect(empty.sent).toEqual([]);
  expect(empty.notices).toContain("No task to continue. Send a task first.");

  const busy = fixture();

  sessionServices(busy.ctx as any).continueTeam = () => {
    throw new Error("Member busy");
  };

  await busy.run();
  expect(busy.sent).toEqual([]);
  expect(busy.notices).toContain("Continue: Member busy");
});

test("concurrent continuation commands do not schedule duplicate runs", async () => {
  const state = fixture();
  let release!: () => void;

  sessionServices(state.ctx as any).resumeGoal = async () => {
    await new Promise<void>((done) => {
      release = done;
    });

    return false;
  };

  const first = state.run();

  await state.run();
  release();
  await first;
  expect(state.sent).toHaveLength(1);
});
