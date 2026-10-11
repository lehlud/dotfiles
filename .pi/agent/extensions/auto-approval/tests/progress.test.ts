import { expect, test } from "bun:test";
import {
  InspectionProgress,
  inspection,
  registerProgress,
  PROGRESS_TYPE,
} from "../../conversations/progress.ts";
import { sessionServices } from "../../shared/session/services.ts";

const args = { command: "git status --short; sha256sum accepted; tail -8 progress.md" };
const output = " M source.zig\nabc123  accepted\nPhase 4 remains active\n";
test("unchanged reordered and subset inspections warn once and halt after eight repetitions", () => {
  const guard = new InspectionProgress();
  expect(guard.observe("bash", args, output)).toBe("fresh");
  for (let i = 1; i <= 8; i++) {
    const input = {
      command:
        i % 2
          ? "tail -8 progress.md; git status --short"
          : "sha256sum accepted; git status --short; tail -8 progress.md",
    };
    expect(
      guard.observe("bash", input, i % 2 ? "Phase 4 remains active\n M source.zig" : output),
    ).toBe(i === 4 ? "warn" : i === 8 ? "halt" : "repeat");
  }
});
test("changed evidence, actual work, new read targets and explicit reset end a stale sequence", () => {
  const guard = new InspectionProgress();
  guard.observe("bash", args, output);
  for (let i = 0; i < 6; i++) guard.observe("bash", args, output);
  expect(guard.observe("bash", args, output + "new hash  candidate")).toBe("fresh");
  expect(guard.repeats).toBe(0);
  guard.observe("bash", args, output);
  expect(guard.observe("bash", { command: "zig build -Doptimize=ReleaseFast" }, "success")).toBe(
    "fresh",
  );
  expect(guard.observe("bash", args, output)).toBe("fresh");
  expect(guard.observe("read", { path: "one" }, "same header")).toBe("fresh");
  expect(guard.observe("read", { path: "two" }, "same header")).toBe("fresh");
  expect(guard.observe("read", { path: "two" }, "first\nsecond")).toBe("fresh");
  expect(guard.observe("read", { path: "two" }, "second\nfirst")).toBe("fresh");
  expect(guard.observe("bash", args, output.replace("source.zig", "source.zig "))).toBe("fresh");
  guard.reset();
  expect(guard.observe("bash", args, output)).toBe("fresh");
});
test("inspection recognition neither executes shell nor mistakes mixed work for a status batch", () => {
  for (const command of [
    "git status --short; zig version",
    "cat 'a;b'; ls",
    "command -v objdump || true",
  ])
    expect(inspection("bash", { command })).toBe(true);
  for (const command of [
    "git status; git commit -m work",
    "cat file > saved",
    "sed -i x file",
    "git diff --output=changes",
    "python3 - <<'PY'\nprint(1)\nPY",
    "cat $(touch file)",
    "cat file; rm other",
    "npm install",
  ])
    expect(inspection("bash", { command })).toBe(false);
});
test("empty and large observations stay bounded and new targets remain possible", () => {
  const guard = new InspectionProgress();
  expect(guard.observe("ls", { path: "one" }, "")).toBe("fresh");
  expect(guard.observe("ls", { path: "two" }, "")).toBe("fresh");
  expect(guard.observe("ls", { path: "two" }, "")).toBe("repeat");
  expect(guard.observe("bash", args, "x".repeat(65537))).toBe("fresh");
  for (let i = 0; i < 5000; i++) guard.observe("read", { path: String(i) }, "bounded");
  expect(guard.observe("read", { path: "0" }, "bounded")).toBe("fresh");
});

function fixture() {
  const hooks: Record<string, any> = {},
    entries: any[] = [],
    notices: string[] = [];
  let aborts = 0,
    pauses = 0,
    stops = 0;
  const ctx: any = {
    sessionManager: {},
    abort() {
      aborts++;
    },
    ui: { notify: (text: string) => notices.push(text) },
  };
  registerProgress({
    on: (name: string, fn: any) => {
      hooks[name] = fn;
    },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
  } as any);
  hooks.session_start({}, ctx);
  Object.assign(sessionServices(ctx), {
    operatorGoal: () => "finish",
    interruptGoal: () => pauses++,
    stopTeam: async () => {
      stops++;
    },
  });
  const observe = () =>
    hooks.tool_result(
      {
        toolName: "approved_action",
        content: [
          { type: "text", text: `Approval display ${Math.random()}` },
          { type: "text", text: output },
        ],
        details: { approval: { decision: "approve", action: { tool: "bash", arguments: args } } },
      },
      ctx,
    );
  return { hooks, entries, notices, ctx, observe, counts: () => ({ aborts, pauses, stops }) };
}
test("warnings affect model context only, automatic goal turns do not reset them, and halt cancels once", () => {
  const state = fixture();
  state.hooks.before_agent_start({}, state.ctx);
  state.observe();
  for (let i = 0; i < 4; i++) state.observe();
  state.hooks.before_agent_start({}, state.ctx);
  const messages: any[] = [{ role: "user", content: "original" }],
    original = structuredClone(messages);
  const context = state.hooks.context({ messages }, state.ctx);
  expect(messages).toEqual(original);
  expect(context.messages.at(-1).customType).toBe(PROGRESS_TYPE);
  for (let i = 0; i < 4; i++) state.observe();
  state.observe();
  expect(state.counts()).toEqual({ aborts: 1, pauses: 1, stops: 1 });
  expect(state.entries.map((entry) => entry.customType)).toEqual([
    "conversation-progress-warning",
    "conversation-progress-halt",
  ]);
  sessionServices(state.ctx).resetProgress!();
  state.observe();
  expect(state.counts().aborts).toBe(1);
});
test("operator steering resets the guard; mailbox and denied actions do not count as observations", () => {
  const state = fixture();
  state.observe();
  for (let i = 0; i < 7; i++) state.observe();
  state.hooks.input({ source: "interactive" }, state.ctx);
  state.observe();
  for (const event of [
    { toolName: "mailbox" },
    { toolName: "approved_action", details: { decision: "deny" } },
  ])
    state.hooks.tool_result(event, state.ctx);
  expect(state.counts().aborts).toBe(0);
});
