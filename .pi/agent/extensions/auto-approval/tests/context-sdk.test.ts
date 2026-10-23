import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { textContent } from "../../shared/review/protocol.ts";
import { cacheStream } from "../../shared/providers/cache-stream.ts";
import contextManagement from "../../context-management/index.ts";
import codeQuality from "../../code-quality/index.ts";
import subagents from "../../subagents/index.ts";
import { NOTE, readNotes } from "../../context-management/archive.ts";
import { sessionServices } from "../../shared/session/services.ts";

const usage = {
  input: 100,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 101,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const tool = (name: string, args: unknown) => [
  { type: "toolCall", id: crypto.randomUUID(), name, arguments: args },
];

function wireResponse() {
  const item = {
    id: "message-cache-fixture",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "done", annotations: [] }],
  };
  const events = [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, delta: "done" },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "response-cache-fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 },
      },
    },
  ];

  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

async function fixture(
  script: (turn: number) => any[],
  setup: {
    provider?: string;
    api?: string;
    pressure?: boolean;
    usedTokens?: number;
    wire?: boolean;
    login?: boolean;
    id?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-sdk-"));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const contexts: any[] = [],
    requests: any[] = [],
    headers: any[] = [],
    errors: any[] = [];
  const provider = setup.provider ?? "context-fixture",
    api = setup.api ?? "openai-completions";

  runtime.registerProvider(provider, {
    api: api as any,
    apiKey: "synthetic",
    baseUrl:
      provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : provider === "anthropic"
          ? "https://api.anthropic.com"
          : setup.wire
            ? "https://api.openai.com/v1"
            : "https://example.invalid",
    models: [
      {
        id: setup.id ?? "working",
        name: "working",
        reasoning: false,
        input: ["text"],
        contextWindow: 65536,
        maxTokens: 4096,
        compat: { supportsExplicitPromptCacheMode: setup.wire === true },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const turn = contexts.push(structuredClone(context.messages));

      if (setup.wire) {
        return cacheStream(responses)(model as any, context, {
          ...options,
          apiKey: setup.login ? "synthetic-login-token" : "sk-synthetic",
          fetch: (async (_url: unknown, init: any) => {
            requests.push(JSON.parse(init.body));

            return wireResponse();
          }) as typeof fetch,
        });
      }

      void (async () => {
        const body = { model: model.id, tools: [{ name: "history" }] };

        requests.push((await options?.onPayload?.(body, model)) ?? body);
        headers.push(structuredClone(options?.headers ?? {}));

        const content = script(turn);
        const message: any = {
          role: "assistant",
          api,
          provider,
          model: model.id,
          timestamp: Date.now(),
          content,
          stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
          usage:
            setup.usedTokens !== undefined || setup.pressure
              ? {
                  ...usage,
                  input: setup.usedTokens ?? 52000,
                  totalTokens: (setup.usedTokens ?? 52000) + 1,
                }
              : usage,
        };

        stream.push({ type: "done", reason: message.stopReason, message });
      })().catch((error) => {
        errors.push(error);
        stream.end();
      });

      return stream;
    },
  });

  const manager = SessionManager.inMemory(directory);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1000, reserveTokens: 4096 },
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: setup.wire
      ? [codeQuality, subagents, contextManagement]
      : [contextManagement],
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model: new ModelRegistry(runtime).find(provider, setup.id ?? "working")!,
    thinkingLevel: "off",
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    tools: ["history", "notes", "new_context"],
  });

  await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });

  return {
    session,
    manager,
    contexts,
    requests,
    headers,
    errors,
    async close() {
      session.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.each([false, true])(
  "real Responses requests preserve reusable history boundaries; login=%s",
  async (login) => {
    const state = await fixture(() => [], {
      provider: "openai",
      api: "openai-responses",
      wire: true,
      login,
    });

    try {
      await state.session.prompt("Original operator task.");
      state.manager.appendCustomEntry(NOTE, { key: "progress", text: "New working notes." });
      await state.session.prompt("Continue the operator task.");

      expect(state.errors).toEqual([]);
      expect(state.requests).toHaveLength(2);

      const [first, second] = state.requests;

      if (login) {
        expect(first.prompt_cache_options).toBeUndefined();
        expect(JSON.stringify(second)).not.toContain("prompt_cache_breakpoint");

        return;
      }

      expect(first.prompt_cache_options).toEqual({ mode: "explicit" });
      expect(second.prompt_cache_options).toEqual({ mode: "explicit" });

      const firstTask = first.input.findIndex((item: any) => item.role === "user");

      expect(second.input.slice(0, firstTask + 1)).toEqual(first.input.slice(0, firstTask + 1));
      expect(first.input[firstTask].content[0].prompt_cache_breakpoint).toEqual({
        mode: "explicit",
      });
      expect(
        first.input
          .slice(firstTask + 1)
          .every((item: any) => !JSON.stringify(item).includes("prompt_cache_breakpoint")),
      ).toBe(true);
      expect(JSON.stringify(second.input)).toContain("New working notes.");
      expect(JSON.stringify(state.manager.getBranch())).not.toContain("prompt_cache_breakpoint");
    } finally {
      await state.close();
    }
  },
);

test("OpenRouter Responses requests cache history before custom hints", async () => {
  const state = await fixture(() => [], {
    provider: "openrouter",
    api: "openai-responses",
    id: "openai/gpt-6.1-sol",
    wire: true,
  });

  try {
    await state.session.prompt("Original task");
    await state.session.prompt("Continue");

    expect(state.errors).toEqual([]);
    expect(state.requests).toHaveLength(2);

    for (const body of state.requests) {
      expect(body.prompt_cache_options.mode).toBe("explicit");
      expect(
        body.input.find((item: any) => item.role === "user").content[0].prompt_cache_breakpoint,
      ).toEqual({ mode: "explicit" });
      expect(body.input.at(-1).content[0].prompt_cache_breakpoint).toBeUndefined();
    }
  } finally {
    await state.close();
  }
});

test("SDK rotation preserves user identity and notes, removes complete tool history and retrieves the exact archived output", async () => {
  let evidence = "";
  const state = await fixture((turn) =>
    turn === 1
      ? tool("notes", {
          operation: "set",
          key: "handoff",
          text: "Keep the broad goal; remaining validation is not finished.",
        })
      : turn === 2
        ? tool("new_context", {})
        : turn === 3
          ? tool("history", { id: evidence, offset: 0, limit: 30 })
          : [{ type: "text", text: "Resumed with exact evidence." }],
  );

  try {
    const id = state.manager.getSessionId();
    const constraint = state.manager.appendMessage({
      role: "user",
      content: "Broad goal; NEVER edit ROADMAP.md.",
      timestamp: 0,
    });

    state.manager.appendMessage({
      role: "assistant",
      api: "fixture",
      provider: "fixture",
      model: "working",
      timestamp: 0,
      stopReason: "toolUse",
      usage,
      content: [{ type: "toolCall", id: "prior", name: "read", arguments: {} }],
    } as any);
    evidence = state.manager.appendMessage({
      role: "toolResult",
      toolName: "read",
      toolCallId: "prior",
      isError: false,
      timestamp: 0,
      content: [{ type: "text", text: "EXACT-EVIDENCE:" + "x".repeat(2000) }],
    });
    await state.session.reload();
    await state.session.prompt("Continue the original goal.");

    expect(state.errors).toEqual([]);
    expect(state.contexts).toHaveLength(4);
    expect(state.manager.getSessionId()).toBe(id);
    expect(state.manager.getEntry(evidence)).toMatchObject({
      message: { content: [{ text: expect.stringContaining("EXACT-EVIDENCE:") }] },
    });
    expect(state.manager.getEntry(constraint)).toMatchObject({ message: { role: "user" } });
    expect(
      state.contexts[2].some((message: any) => ["assistant", "toolResult"].includes(message.role)),
    ).toBe(false);
    expect(JSON.stringify(state.contexts[2])).toContain("NEVER edit ROADMAP.md");
    expect(JSON.stringify(state.contexts[2])).toContain("remaining validation is not finished");
    expect(JSON.stringify(state.contexts[3])).toContain("EXACT-EVIDENCE:");
    expect([...readNotes(state.manager.getBranch())]).toEqual([
      ["handoff", "Keep the broad goal; remaining validation is not finished."],
    ]);
  } finally {
    await state.close();
  }
});

test("SDK notes and original history survive fallback compaction and extension reload", async () => {
  const state = await fixture(() => [
    { type: "text", text: "Concise fallback summary; work is incomplete." },
  ]);

  try {
    const original = state.manager.appendMessage({
      role: "user",
      content: "ORIGINAL-UNSUMMARIZED-USER",
      timestamp: 0,
    });

    state.manager.appendMessage({
      role: "assistant",
      api: "fixture",
      provider: "fixture",
      model: "working",
      content: [{ type: "text", text: "old model output ".repeat(6000) }],
      stopReason: "stop",
      usage,
      timestamp: 0,
    } as any);
    state.manager.appendCustomEntry(NOTE, { key: "next", text: "Validation still required." });
    state.manager.appendMessage({ role: "user", content: "Recent refinement", timestamp: 1 });
    await state.session.reload();
    await state.session.compact();
    await state.session.reload();
    await state.session.prompt("Continue.");

    expect(state.errors).toEqual([]);
    expect(state.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    expect(state.manager.getEntry(original)).toMatchObject({
      message: { content: "ORIGINAL-UNSUMMARIZED-USER" },
    });
    expect(JSON.stringify(state.contexts.at(-1))).toContain("Validation still required");
  } finally {
    await state.close();
  }
});

test("SDK pressure pruning commits append-only projections before the next provider request", async () => {
  const state = await fixture(() => [{ type: "text", text: "done" }], { pressure: true });

  try {
    state.manager.appendMessage({ role: "user", content: "Preserve the task.", timestamp: 0 });

    const outputs: string[] = [];

    for (let index = 0; index < 12; index++) {
      state.manager.appendMessage({
        role: "assistant",
        api: "fixture",
        provider: "fixture",
        model: "working",
        content: [{ type: "toolCall", id: `old-${index}`, name: "read", arguments: {} }],
        stopReason: "toolUse",
        usage,
        timestamp: 0,
      } as any);
      outputs.push(
        state.manager.appendMessage({
          role: "toolResult",
          toolName: "read",
          toolCallId: `old-${index}`,
          isError: false,
          content: [{ type: "text", text: "unique-evidence-" + index + "x".repeat(20000) }],
          timestamp: 0,
        }),
      );
    }

    await state.session.reload();
    await state.session.prompt("Continue.");
    expect(state.manager.getBranch().some((entry) => entry.type === "context_edit")).toBe(true);
    expect(state.manager.getEntry(outputs[0])).toMatchObject({
      message: { content: [{ text: expect.stringContaining("unique-evidence-0") }] },
    });
    await state.session.prompt("Continue after pruning.");
    expect(JSON.stringify(state.contexts.at(-1))).toContain("[Archived output; history id=");
    expect(state.errors).toEqual([]);
  } finally {
    await state.close();
  }
});

test("SDK native clearing changes only opted-in direct Anthropic requests and persists across reload", async () => {
  const state = await fixture(() => [{ type: "text", text: "done" }], {
    provider: "anthropic",
    api: "anthropic-messages",
  });

  try {
    await state.session.prompt("Before native clearing.");
    await state.session.prompt("/context native on");
    await state.session.prompt("After native clearing.");
    await state.session.reload();
    await state.session.prompt("Still native.");
    await state.session.prompt("/context native off");
    await state.session.prompt("Native disabled.");

    expect(state.errors).toEqual([]);
    expect(state.requests).toHaveLength(4);
    expect(state.requests[0]).toEqual(state.requests[3]);
    expect(state.requests[1]).toMatchObject({
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    });
    expect(state.requests[2]).toEqual(state.requests[1]);
    expect(state.headers[1]["anthropic-beta"]).toContain("context-management-2025-06-27");
    expect(state.headers[0]["anthropic-beta"]).toBeUndefined();
    expect(JSON.stringify(state.contexts.at(-1))).not.toContain("/context native");
  } finally {
    await state.close();
  }
});

test("SDK invalid metadata requests cannot read files or inject settings, and busy delegates block rotation", async () => {
  const state = await fixture((turn) =>
    turn === 1
      ? tool("history", { id: "../../auth.json" })
      : turn === 2
        ? tool("notes", { operation: "set", key: "oversized", text: "x".repeat(8001) })
        : turn === 3
          ? tool("new_context", {})
          : [{ type: "text", text: "bounded failure handled" }],
  );

  try {
    sessionServices({ sessionManager: state.manager }).subagentsBusy = () => true;
    await state.session.prompt("Keep this session scoped.");

    expect(state.errors).toEqual([]);

    const results = state.manager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
      );

    expect(results).toHaveLength(3);
    expect(results.every((message) => message.isError)).toBe(true);
    expect(state.manager.getBranch().some((entry) => entry.type === "context_edit")).toBe(false);
    expect(readNotes(state.manager.getBranch()).size).toBe(0);
  } finally {
    await state.close();
  }
});

test("SDK rotation cannot spin on repeated notes/history-only work", async () => {
  const state = await fixture((turn) =>
    turn <= 2 ? tool("new_context", {}) : [{ type: "text", text: "Continue useful work." }],
  );

  try {
    await state.session.prompt("Complete the task.");

    const markers = state.manager
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "context-memory-rotation-state",
      );
    const failures = state.manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
      );

    expect(markers).toHaveLength(1);
    expect(JSON.stringify(failures)).toContain("Context already rotated");
    expect(state.contexts).toHaveLength(3);
    expect(state.errors).toEqual([]);
  } finally {
    await state.close();
  }
});

test.each(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"])(
  "critical %s context renews even when the model never calls new_context",
  async (api) => {
    const state = await fixture(
      (turn) =>
        turn === 1
          ? tool("notes", {
              operation: "set",
              key: "next",
              text: "Implement the remaining allocator; validation is incomplete.",
            })
          : [{ type: "text", text: "Continue the implementation with fresh context." }],
      { usedTokens: 60000, api },
    );

    try {
      const original = state.manager.appendMessage({
        role: "assistant",
        api: "fixture",
        provider: "fixture",
        model: "working",
        timestamp: 0,
        content: [{ type: "text", text: "archived-observation ".repeat(8000) }],
        stopReason: "stop",
        usage,
      } as any);

      await state.session.prompt("Finish the authorized task; never edit ROADMAP.md.");

      const markers = state.manager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "context-memory-rotation-state",
        );

      expect(state.errors).toEqual([]);
      expect(markers).toHaveLength(1);
      expect(state.contexts).toHaveLength(2);
      expect(JSON.stringify(state.contexts[1]).length).toBeLessThan(16000);

      const memory = state.contexts[1]
        .map((message: any) => textContent(message.content))
        .find(
          (text: string) => text.includes("Headroom is per request") && text.includes("\nBudget: "),
        )!;
      const requestBudget = JSON.parse(memory.split("\nBudget: ")[1].split("\n")[0]);

      expect(memory).toContain("not a task/session budget");
      expect(requestBudget.available).toBeGreaterThan(50000);
      expect(requestBudget.renewal).toBe(false);

      expect(JSON.stringify(state.contexts[1])).toContain("Implement the remaining allocator");
      expect(JSON.stringify(state.contexts[1])).toContain("never edit ROADMAP.md");
      expect(state.manager.getEntry(original)).toMatchObject({
        message: { content: [{ type: "text", text: "archived-observation ".repeat(8000) }] },
      });
    } finally {
      await state.close();
    }
  },
);
