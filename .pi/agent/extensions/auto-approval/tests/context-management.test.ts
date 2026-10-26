import contextManagement from "../../context-management/index.ts";
import { renewContext, AUTOMATIC_HANDOFF } from "../../context-management/renewal.ts";
import { expect, test } from "bun:test";
import { SessionManager, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { originals, historyPage, readNotes, NOTE } from "../../context-management/archive.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { budget, profile } from "../../context-management/budget.ts";
import {
  nativePayload,
  nativeToolClearing,
  nativeHeaders,
} from "../../context-management/providers.ts";
import { prune, rotate, rotationSavings } from "../../context-management/projection.ts";
import { FAILURE_INDEX } from "../../context-management/failures.ts";
import { previousDenials } from "../../shared/review/receipts.ts";
import { availableContextTools } from "../../shared/contracts/context.ts";

const model = {
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  contextWindow: 200000,
  maxTokens: 8192,
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: any[]) =>
  ({
    role: "assistant",
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    timestamp: 0,
    stopReason: "toolUse",
    content,
    usage,
  }) as any;

function transcript(signed = false) {
  const manager = SessionManager.inMemory("/project");
  const user = manager.appendMessage({
    role: "user",
    content: "Preserve this exact operator constraint.",
    timestamp: 0,
  });
  const outputs: string[] = [];

  for (let index = 0; index < 10; index++) {
    manager.appendMessage(
      assistant([
        ...(signed
          ? [{ type: "thinking", thinking: "hidden", thinkingSignature: "signed-secret" }]
          : []),
        {
          type: "toolCall",
          id: `call-${index}`,
          name: "approved_action",
          arguments: { tool: "read", arguments: { path: "sample.txt" } },
        },
      ]),
    );
    outputs.push(
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "approved_action",
        isError: index === 1,
        content: [
          {
            type: "text",
            text: `${index === 1 ? "DENIED" : "evidence"}-${index}:` + "x".repeat(20000),
          },
        ],
        timestamp: index,
      }),
    );
  }

  return { manager, user, outputs };
}

function apply(manager: SessionManager, drafts: SessionBoundaryDraft[]) {
  for (const draft of drafts) {
    if (draft.type === "context_edit") manager.appendContextEdit(draft.targetId, draft.replacement);

    if (draft.type === "custom_message")
      manager.appendCustomMessageEntry(
        draft.customType,
        draft.content,
        draft.display,
        draft.details,
      );
  }
}

test("batched pruning preserves original data, calls, errors and the six most recent results", () => {
  const { manager, outputs, user } = transcript();
  const raw = originals(manager.getBranch());
  const changes = prune(manager.buildSessionProjection().entries, 40000, true);

  expect(changes).toHaveLength(3);
  apply(manager, changes);
  expect(originals(manager.getBranch())).toEqual(raw);
  expect(
    manager.buildSessionProjection().messages.filter((message) => message.role === "assistant"),
  ).toHaveLength(10);
  expect(historyPage(manager.getBranch(), { id: outputs[0], offset: 0, limit: 30 })).toContain(
    "evidence-0:",
  );
  expect(
    manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === user)
      ?.messages[0],
  ).toMatchObject({ role: "user", content: raw[0].text });

  for (const id of [outputs[1], ...outputs.slice(-6)])
    expect(
      JSON.stringify(
        manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id)
          ?.messages,
      ),
    ).not.toContain("[Archived output");

  expect(prune(manager.buildSessionProjection().entries, 40000, true)).toEqual([]);
});

test("pruning leaves signed histories intact and avoids small cache-invalidating edits", () => {
  const { manager } = transcript(true);

  expect(prune(manager.buildSessionProjection().entries, 16000, true)).toEqual([]);
  expect(prune(manager.buildSessionProjection().entries, 16000, false).length).toBeGreaterThan(0);
  expect(prune(manager.buildSessionProjection().entries.slice(-2), 16000, false)).toEqual([]);
});

test("no-summary rotation removes complete signed tool batches while retaining user/system/custom constraints and failures", () => {
  const { manager, user, outputs } = transcript(true);
  const id = manager.getSessionId();

  manager.appendMessage({ role: "system", content: "protected system state", timestamp: 0 } as any);
  manager.appendCustomMessageEntry("subagent-parent-message", "Assigned bounded task DATA", false);
  manager.appendCustomEntry("auto-approval-review", { requestId: "denial", decision: "deny" });

  const raw = originals(manager.getBranch());

  apply(manager, rotate(manager.buildSessionProjection().entries));

  const projection = manager.buildSessionProjection();

  expect(manager.getSessionId()).toBe(id);
  expect(
    projection.messages.some((message) => ["assistant", "toolResult"].includes(message.role)),
  ).toBe(false);
  expect(projection.entries.find((entry) => entry.sourceEntry.id === user)?.messages).toHaveLength(
    1,
  );
  expect(JSON.stringify(projection.messages)).toContain("protected system state");
  expect(JSON.stringify(projection.messages)).toContain("Assigned bounded task DATA");
  expect(JSON.stringify(projection.messages)).toContain("DENIED-1");
  expect(
    manager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "auto-approval-review"),
  ).toBe(true);
  expect(originals(manager.getBranch()).slice(0, raw.length)).toEqual(raw);
  expect(historyPage(manager.getBranch(), { id: outputs[0], tail: true, limit: 20 })).toContain(
    "x".repeat(20),
  );
  expect(() => historyPage(manager.getBranch(), { id: "other-session-id" })).toThrow(
    "Unknown history ID",
  );
});

test("history is bounded, uses literal search and ignores unrelated metadata and opaque signatures", () => {
  const { manager, outputs } = transcript(true);

  manager.appendCustomEntry("private-internal-config", { password: "not-model-visible" });
  expect(historyPage(manager.getBranch(), { query: "evidence-2" })).toContain(outputs[2]);
  expect(historyPage(manager.getBranch(), { query: ".*" })).toContain("0 matching entries");
  expect(historyPage(manager.getBranch(), { query: "signed-secret" })).toContain(
    "0 matching entries",
  );
  expect(historyPage(manager.getBranch(), { query: "not-model-visible" })).toContain(
    "0 matching entries",
  );
  expect(() => historyPage(manager.getBranch(), { id: "../../auth.json" })).toThrow(
    "Unknown history ID",
  );
  expect(
    historyPage(manager.getBranch(), { id: outputs[2], offset: 0, limit: 10 }).length,
  ).toBeLessThan(220);
});

test("working notes preserve revisions and tombstones across compaction and context edits", () => {
  const manager = SessionManager.inMemory("/project");

  manager.appendCustomEntry(NOTE, { key: "task", text: "first" });
  manager.appendCustomEntry(NOTE, { key: "task", text: "next" });
  manager.appendCustomEntry(NOTE, { key: "remove", text: "obsolete" });
  manager.appendCustomEntry(NOTE, { key: "remove", text: null });
  manager.appendCompaction("summary", null, 100);

  expect([...readNotes(manager.getBranch())]).toEqual([["task", "next"]]);
  expect(historyPage(manager.getBranch(), { query: "first" })).toContain("note:data");
});

test("budgets account for the selected model, cached input, unknown usage and output reserve", () => {
  const ctx: any = { model, getContextUsage: () => ({ tokens: 190000, contextWindow: 200000 }) };

  expect(budget(ctx)).toMatchObject({
    used: 190000,
    reserve: 8192,
    available: 1808,
    pressure: true,
    profile: "signed-history",
  });
  ctx.getContextUsage = () => ({ tokens: null, contextWindow: 200000 });
  expect(budget(ctx)).toMatchObject({ available: null, pressure: false });
  ctx.model = { ...model, contextWindow: 12000 };
  expect(budget(ctx).window).toBe(12000);
  expect(budget(ctx).reserve).toBe(4000);
  expect(profile({ ...model, api: "openai-codex-responses" })).toBe("responses");
  expect(profile({ ...model, api: "google-generative-ai" })).toBe("signed-history");
});

test.each([
  [272000, 128000, 208896],
  [200000, 8192, 153600],
  [200000, 16384, 153600],
])(
  "archiving starts at 76.8%% of window %i with output limit %i",
  (window, maxTokens, threshold) => {
    let tokens = threshold - 1;
    const ctx: any = {
      model: { ...model, contextWindow: window, maxTokens },
      getContextUsage: () => ({ tokens, contextWindow: window }),
    };

    expect(budget(ctx).pressure).toBe(false);
    tokens = threshold;
    expect(budget(ctx).pressure).toBe(true);
  },
);

test("native Anthropic tool clearing is opt-in, route-scoped and preserves existing request controls", () => {
  const headers = {
    "Anthropic-Beta": " operator-beta ,context-management-2025-06-27",
    "X-Trace": "keep",
  };

  nativeHeaders(headers, model, true);
  expect(headers).toEqual({
    "Anthropic-Beta": "operator-beta,context-management-2025-06-27",
    "X-Trace": "keep",
  });
  expect(() => nativeHeaders({ "anthropic-beta": null }, model, true)).toThrow(
    "explicit anthropic-beta header suppression",
  );

  const payload = {
    tools: [{ name: "read" }],
    metadata: { user_id: "session" },
    context_management: { edits: ["operator-choice"] },
  };

  expect(nativePayload(payload, model, true)).toBeUndefined();
  expect(nativePayload({ tools: [] }, model, true)).toBeUndefined();
  expect(nativePayload({ tools: ["read"] }, model, false)).toBeUndefined();
  expect(nativePayload({ tools: ["read"] }, model, true)).toMatchObject({
    context_management: {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          keep: { value: 6 },
          exclude_tools: ["history", "notes", "new_context"],
        },
      ],
    },
  });

  for (const baseUrl of [
    "http://api.anthropic.com",
    "https://api.anthropic.com.evil.invalid",
    "https://api.anthropic.com:444",
    "https://proxy.invalid",
  ])
    expect(nativeToolClearing({ ...model, baseUrl }, true)).toBe(false);

  expect(nativeToolClearing({ ...model, provider: "openrouter" }, true)).toBe(false);
  expect(payload.context_management.edits).toEqual(["operator-choice"]);
});

test("only registered session metadata tools are available outside action approval", () => {
  expect(
    availableContextTools({ getAllTools: () => [{ name: "history" }, { name: "bash" }] } as any),
  ).toEqual(["history"]);
});

test.each(["no-op", "prune", "rotate"])(
  "context %s preserves another extension's pending continuation",
  async (mode) => {
    const hooks: Record<string, Function> = {},
      tools: Record<string, any> = {};

    contextManagement({
      on: (name: string, callback: Function) => {
        hooks[name] = callback;
      },
      registerCommand() {},
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
    } as any);

    const manager = mode === "no-op" ? SessionManager.inMemory("/project") : transcript().manager;
    const ctx: any = {
      model: { ...model, api: "openai-responses" },
      getContextUsage: () => ({ tokens: 170000, contextWindow: model.contextWindow }),
      sessionManager: manager,
    };
    const drafts: SessionBoundaryDraft[] = [
      {
        type: "custom_message",
        customType: "goal-next-turn",
        content: "Continue the existing task",
        display: false,
      },
    ];

    if (mode === "rotate")
      await tools.new_context.execute("rotation", {}, undefined, undefined, ctx);

    const result = await hooks.turn_end(
      {
        outcome: "completed",
        entries: drafts,
        continue: true,
        context: { contextEntries: manager.buildSessionProjection().entries },
      },
      ctx,
    );
    const effective = result?.entries ?? drafts;

    expect(effective[0]).toEqual(drafts[0]);
    expect(drafts).toHaveLength(1);

    if (mode === "no-op") expect(result).toBeUndefined();
    else
      expect(effective.some((entry: SessionBoundaryDraft) => entry.type === "context_edit")).toBe(
        true,
      );
  },
);

test.each([
  [272000, 128000, 244800],
  [200000, 8192, 180000],
  [12000, 4096, 8000],
])(
  "renewal starts before output reserve exhaustion for window %i",
  (window, maxTokens, threshold) => {
    let tokens = threshold - 1;
    const ctx: any = {
      model: { ...model, contextWindow: window, maxTokens },
      getContextUsage: () => ({ tokens }),
    };

    expect(budget(ctx).renewal).toBe(false);
    tokens++;
    expect(budget(ctx).renewal).toBe(true);
    ctx.getContextUsage = () => ({ tokens: null });
    expect(budget(ctx).renewal).toBe(false);
  },
);

test("automatic renewal retains notes, constraints, failure evidence and exact archive references", () => {
  const { manager, user, outputs } = transcript(true);

  manager.appendCustomEntry(NOTE, { key: "next", text: "Implement the allocator, then validate." });
  manager.appendCustomEntry("auto-approval-review", { decision: "deny", requestId: "keep-denial" });

  const raw = originals(manager.getBranch());
  const changes = renewContext(manager.buildSessionProjection().entries)!;

  expect(changes).toBeDefined();
  apply(manager, changes);

  const messages = manager.buildSessionProjection().messages;
  const handoff = messages.find(
    (message) => message.role === "custom" && message.customType === AUTOMATIC_HANDOFF,
  );

  expect(JSON.stringify(handoff)).toContain(outputs.at(-1)!);
  expect(JSON.stringify(handoff)).not.toContain("signed-secret");
  expect(JSON.stringify(handoff).length).toBeLessThan(6500);
  expect(
    messages.some((message) => message.role === "assistant" || message.role === "toolResult"),
  ).toBe(false);
  expect(messages.some((message) => message.role === "user")).toBe(true);
  expect(manager.getEntry(user)).toBeDefined();
  expect([...readNotes(manager.getBranch())]).toEqual([
    ["next", "Implement the allocator, then validate."],
  ]);
  expect(JSON.stringify(messages)).toContain("DENIED-1");
  expect(originals(manager.getBranch()).slice(0, raw.length)).toEqual(raw);
  expect(manager.getBranch().some((entry: any) => entry.data?.requestId === "keep-denial")).toBe(
    true,
  );
});

test("renewal skips small or irreducible history and tool images unavailable through text history", () => {
  const manager = SessionManager.inMemory("/project");

  manager.appendMessage({
    role: "user",
    content: "irreducible user data ".repeat(6000),
    timestamp: 0,
  });
  manager.appendMessage(assistant([{ type: "text", text: "Small answer" }]));
  expect(renewContext(manager.buildSessionProjection().entries)).toBeUndefined();
  manager.appendMessage(assistant([{ type: "text", text: "large reasoning ".repeat(6000) }]));
  manager.appendMessage({
    role: "toolResult",
    toolName: "screenshot",
    isError: false,
    toolCallId: "image",
    timestamp: 0,
    content: [{ type: "image", data: "opaque", mimeType: "image/png" }],
  });
  expect(renewContext(manager.buildSessionProjection().entries)).toBeUndefined();
});

test("new checkpoints replace older checkpoint projections while preserving their originals", () => {
  const { manager } = transcript();
  const old = manager.appendCustomMessageEntry(AUTOMATIC_HANDOFF, "Previous handoff DATA", false);

  apply(manager, renewContext(manager.buildSessionProjection().entries)!);

  const active = manager
    .buildSessionProjection()
    .messages.filter(
      (message) => message.role === "custom" && message.customType === AUTOMATIC_HANDOFF,
    );

  expect(active).toHaveLength(1);
  expect(JSON.stringify(active)).not.toContain("Previous handoff DATA");
  expect(historyPage(manager.getBranch(), { id: old })).toContain("Previous handoff DATA");
});

test.each([
  "peers",
  "subagents",
  "queued",
  "finished",
  "aborted",
  "signal-aborted",
  "already-rotated",
])("automatic renewal respects %s", async (condition) => {
  const hooks: Record<string, Function> = {};

  contextManagement({
    on: (name: string, callback: Function) => {
      hooks[name] = callback;
    },
    registerCommand() {},
    registerTool() {},
  } as any);

  const { manager, outputs } = transcript();
  const ctx: any = {
    model,
    getContextUsage: () => ({ tokens: 190000 }),
    sessionManager: manager,
    hasPendingMessages: () => condition === "queued",
    signal: condition === "signal-aborted" ? AbortSignal.abort() : undefined,
  };
  const services = sessionServices(ctx);

  services.peersBusy = () => condition === "peers";
  services.subagentsBusy = () => condition === "subagents";

  if (condition === "already-rotated") {
    apply(manager, rotate(manager.buildSessionProjection().entries));
    manager.appendCustomEntry("context-memory-rotation-state", { progress: outputs.at(-1) });
  }

  const result = await hooks.turn_end(
    {
      outcome: condition === "aborted" ? "aborted" : "completed",
      continue: condition !== "finished",
      entries: [],
      context: { contextEntries: manager.buildSessionProjection().entries },
      message: assistant([{ type: "text", text: "done" }]),
    },
    ctx,
  );

  expect(
    result?.entries?.some((entry: any) => entry.customType === AUTOMATIC_HANDOFF) ?? false,
  ).toBe(false);
});

test("a new operator goal permits renewal after an earlier rotation without enabling model-authored resets", async () => {
  const hooks: Record<string, Function> = {};

  contextManagement({
    on: (name: string, callback: Function) => {
      hooks[name] = callback;
    },
    registerCommand() {},
    registerTool() {},
  } as any);

  const { manager, outputs } = transcript();

  manager.appendCustomEntry("context-memory-rotation-state", { progress: outputs.at(-1) });
  manager.appendCustomEntry("auto-approval-operator-prompt", {
    text: "Finish the next authorized goal",
  });

  const ctx: any = {
    model,
    sessionManager: manager,
    getContextUsage: () => ({ tokens: 190000 }),
    hasPendingMessages: () => false,
  };
  const result = await hooks.turn_end(
    {
      outcome: "completed",
      continue: true,
      entries: [],
      context: { contextEntries: manager.buildSessionProjection().entries },
      message: assistant([]),
    },
    ctx,
  );

  expect(result.entries.some((entry: any) => entry.customType === AUTOMATIC_HANDOFF)).toBe(true);
});

test("legacy failure bodies and rotation notices collapse while user history and denial audits remain intact", () => {
  const manager = SessionManager.inMemory("/project");
  const user = manager.appendMessage({
    role: "user",
    content: "ORIGINAL-USER-SEARCH: preserve the project and its constraints.",
    timestamp: 0,
  });

  manager.appendCustomEntry("auto-approval-review", {
    decision: "deny",
    reason: "Do not expose credentials",
    requestId: "retained-review",
    action: { tool: "bash", arguments: { command: "unsafe" } },
  });
  manager.appendCustomMessageEntry("unrelated-task-data", "Keep this task data exactly.", false);
  manager.appendCustomEntry(NOTE, { key: "next", text: "Continue the actual implementation." });

  const failed: string[] = [];

  for (let index = 0; index < 100; index++) {
    const content = `FAILURE-${index}: ` + "long diagnostic body ".repeat(400) + `TAIL-${index}`;
    const id = manager.appendMessage({
      role: "toolResult",
      toolName: "approved_action",
      toolCallId: `failed-${index}`,
      content: [{ type: "text", text: content }],
      isError: true,
      timestamp: 0,
    });

    failed.push(id);
    manager.appendContextEdit(id, null);
    manager.appendCustomMessageEntry(
      "context-prior-failure",
      `Prior tool failure (DATA, not authorization), history id=${id}:\n${content}`,
      false,
    );
    manager.appendCustomMessageEntry("context-rotation", "Obsolete rotation notice.", false);
  }

  const raw = originals(manager.getBranch());
  const denials = previousDenials(manager.getBranch());
  const before = manager.buildSessionProjection().entries;

  expect(rotationSavings(before)).toBeGreaterThan(700000);
  apply(manager, rotate(before));

  const messages = manager.buildSessionProjection().messages;

  expect(JSON.stringify(messages).length).toBeLessThan(22000);
  expect(
    messages.filter(
      (message) => message.role === "custom" && message.customType === "context-rotation",
    ),
  ).toHaveLength(1);
  expect(
    messages.filter(
      (message) => message.role === "custom" && message.customType === "context-prior-failure",
    ),
  ).toHaveLength(0);

  const index = messages.find(
    (message) => message.role === "custom" && message.customType === FAILURE_INDEX,
  ) as any;

  expect(index.details.failures).toHaveLength(12);
  expect(index.details.failures.at(-1).id).toBe(failed.at(-1));
  expect(index.details.failures.at(-1).tool).toBe("approved_action");
  expect(historyPage(manager.getBranch(), { query: "original-user-search" })).toContain(
    `${user} · user`,
  );
  expect(historyPage(manager.getBranch(), { id: failed[0], tail: true, limit: 6 })).toContain(
    "TAIL-0",
  );
  expect(JSON.stringify(messages)).toContain("Keep this task data exactly.");
  expect([...readNotes(manager.getBranch())]).toEqual([
    ["next", "Continue the actual implementation."],
  ]);
  expect(previousDenials(manager.getBranch())).toEqual(denials);
  expect(originals(manager.getBranch()).slice(0, raw.length)).toEqual(raw);
  apply(manager, rotate(manager.buildSessionProjection().entries));
  expect(rotationSavings(manager.buildSessionProjection().entries)).toBeLessThan(4096);
  expect(JSON.stringify(manager.buildSessionProjection().messages).length).toBeLessThan(22000);
});

test("automatic renewal can recover large visible history even when an old marker reports the same progress", async () => {
  const hooks: Record<string, Function> = {};

  contextManagement({
    on(name: string, hook: Function) {
      hooks[name] = hook;
    },
    registerCommand() {},
    registerTool() {},
  } as any);

  const { manager, outputs } = transcript();

  manager.appendCustomEntry("context-memory-rotation-state", { progress: outputs.at(-1) });

  const ctx: any = {
    sessionManager: manager,
    model,
    getContextUsage: () => ({ tokens: 190000 }),
    hasPendingMessages: () => false,
  };
  const result = await hooks.turn_end(
    {
      outcome: "completed",
      continue: true,
      entries: [],
      message: assistant([]),
      context: { contextEntries: manager.buildSessionProjection().entries },
    },
    ctx,
  );

  expect(result.entries.some((entry: any) => entry.customType === AUTOMATIC_HANDOFF)).toBe(true);
});

test("a small successful file read cannot unlock a negligible repeated rotation", async () => {
  const tools: Record<string, any> = {};

  contextManagement({
    on() {},
    registerCommand() {},
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
  } as any);

  const manager = SessionManager.inMemory("/project");

  manager.appendMessage({ role: "user", content: "Continue the original task.", timestamp: 0 });
  manager.appendCustomEntry("context-memory-rotation-state", { progress: "old-work" });
  manager.appendMessage({
    role: "toolResult",
    toolName: "approved_action",
    toolCallId: "small-read",
    content: [{ type: "text", text: "unchanged file" }],
    isError: false,
    timestamp: 0,
  });

  const ctx: any = { sessionManager: manager };
  const response = await tools.new_context.execute("repeat", {}, undefined, undefined, ctx);

  expect(response.content[0].text).toContain("no substantial additional context");
  expect(response.isError).not.toBe(true);
});
