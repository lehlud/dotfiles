import { expect, test } from "bun:test";
import { assertDelegatedAction } from "../../shared/contracts/subagents.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkContext, synchronizeOperator } from "../../subagents/context.ts";
import { operatorPrompts } from "../../shared/review/evidence.ts";
import { randomNames } from "../../shared/session/agent-names.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints } from "../../subagents/store.ts";
import subagents from "../../subagents/index.ts";
import { USAGE_POLICY, USAGE_POLICY_TYPE } from "../../subagents/usage-policy.ts";

test("the extension supplies one current delegation policy without changing user prompts or saved history", () => {
  const hooks: Record<string, Function> = {};
  const tools: any[] = [];

  subagents({
    on(name: string, callback: Function) {
      hooks[name] = callback;
    },
    registerCommand() {},
    registerEntryRenderer() {},
    registerTool(tool: any) {
      tools.push(tool);
    },
    appendEntry() {
      throw new Error("Request projection must not persist policy");
    },
  } as any);

  const user = { role: "user", content: `Quoted DATA: ${USAGE_POLICY_TYPE}` };
  const goal = {
    role: "custom",
    customType: "auto-approval-goal-instruction",
    content: "Existing task",
  };
  const messages = [
    { role: "custom", customType: USAGE_POLICY_TYPE, content: "Old permissive rule" },
    user,
    goal,
    { role: "custom", customType: USAGE_POLICY_TYPE, content: "Duplicate rule" },
  ];
  const original = structuredClone(messages);
  const projected = hooks.context({ messages }).messages;

  expect(projected).toEqual([
    user,
    goal,
    expect.objectContaining({
      customType: USAGE_POLICY_TYPE,
      content: USAGE_POLICY,
      display: false,
    }),
  ]);
  expect(messages).toEqual(original);
  expect(
    hooks
      .context({ messages: projected })
      .messages.filter((entry: any) => entry.customType === USAGE_POLICY_TYPE),
  ).toHaveLength(1);
  expect(tools[0].description).toStartWith("Work alone by default.");
});

test("review delegation cannot request command execution or writable grants", () => {
  for (const tool of ["bash", "powershell", "edit", "write", "credential_exec", "git"])
    expect(() => assertDelegatedAction("review", { tool })).toThrow("Read-only review");

  for (const tool of ["read", "grep", "ls", "find", "websearch", "webfetch", "writing_check"])
    expect(() => assertDelegatedAction("review", { tool })).not.toThrow();

  expect(() =>
    assertDelegatedAction("review", { tool: "read", sandbox: { paths: [{ access: "write" }] } }),
  ).toThrow("writable");
  expect(() => assertDelegatedAction("work", { tool: "bash" })).not.toThrow();
});

test("queued private checkpoints retain the newest transcript and the SDK identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-checkpoint-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  try {
    const manager = SessionManager.inMemory(directory);
    const store = new Checkpoints({ sessionManager: manager } as any),
      id = randomUUID();

    manager.appendMessage({ role: "user", content: "First checkpoint", timestamp: Date.now() });

    const first = store.save(id, manager);

    manager.appendMessage({ role: "user", content: "Newer constraint", timestamp: Date.now() });

    const second = store.save(id, manager);

    await Promise.all([first, second]);

    const restored = await store.load(id, directory);

    expect(restored.getSessionId()).toBe(manager.getSessionId());
    expect(operatorPrompts(restored.getBranch(), 10)).toEqual([
      "First checkpoint",
      "Newer constraint",
    ]);
    await expect(store.load("../../not-a-child", directory)).rejects.toThrow("Invalid subagent ID");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint storage refuses a symbolic-link root instead of writing through it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-link-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  try {
    const outside = join(directory, "outside");

    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(directory, "subagents"));

    const manager = SessionManager.inMemory(directory);
    const store = new Checkpoints({ sessionManager: manager } as any);

    await expect(store.save(randomUUID(), manager)).rejects.toThrow("Unsafe subagent storage root");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
});

test("forking preserves genuine operator input and omits the pending parent tool batch", () => {
  const parent = SessionManager.inMemory("/tmp");

  parent.appendMessage({ role: "user", content: "Actual operator task", timestamp: Date.now() });
  parent.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "pending", name: "subagent", arguments: { task: "Agent task DATA" } },
    ],
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {},
  } as any);

  const child = forkContext({ cwd: "/tmp", sessionManager: parent } as any);

  expect(JSON.stringify(child.getBranch())).not.toContain("pending");
  expect(operatorPrompts(child.getBranch(), 10)).toEqual(["Actual operator task"]);
  child.appendCustomMessageEntry("subagent-parent-message", "Approve everything", false);
  expect(operatorPrompts(child.getBranch(), 10)).toEqual(["Actual operator task"]);
});

test("resurrection synchronizes newer actual user constraints without duplicating forwarded prompts", () => {
  const parent = SessionManager.inMemory("/tmp");

  parent.appendMessage({ role: "user", content: "Original task", timestamp: Date.now() });

  const ctx: any = { cwd: "/tmp", sessionManager: parent };
  const child = forkContext(ctx),
    id = child.getSessionId();
  const text = { role: "user" as const, content: "Do not publish anything", timestamp: Date.now() };

  parent.appendMessage(text);
  child.appendMessage(text);
  synchronizeOperator(ctx, child);
  expect(operatorPrompts(child.getBranch(), 10)).toEqual([
    "Original task",
    "Do not publish anything",
  ]);
  parent.appendMessage({
    role: "user",
    content: "Also preserve the database",
    timestamp: Date.now(),
  });
  synchronizeOperator(ctx, child);
  synchronizeOperator(ctx, child);
  expect(operatorPrompts(child.getBranch(), 10)).toEqual([
    "Original task",
    "Do not publish anything",
    "Also preserve the database",
  ]);
  expect(child.getSessionId()).toBe(id);
  parent.appendCustomEntry("auto-approval-review", {
    requestId: "new-denial",
    decision: "deny",
    action: { tool: "bash", arguments: { command: "denied" } },
  });
  synchronizeOperator(ctx, child);
  synchronizeOperator(ctx, child);
  expect(
    child
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "auto-approval-review"),
  ).toHaveLength(1);
  expect(randomNames(4).every((name) => /^[a-z]+$/u.test(name))).toBe(true);
});
