import { expect, test } from "bun:test";
import { SessionManager, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { originals, historyPage, readNotes, NOTE } from "../../context-management/archive.ts";
import { budget, profile } from "../../context-management/budget.ts";
import {
  nativePayload,
  nativeToolClearing,
  nativeHeaders,
} from "../../context-management/providers.ts";
import { prune, rotate } from "../../context-management/projection.ts";
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
      manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display);
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
