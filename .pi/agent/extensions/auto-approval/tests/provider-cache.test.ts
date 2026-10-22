import { expect, test } from "bun:test";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { cacheStream } from "../../shared/providers/cache-stream.ts";
import { cacheConversationPayload } from "../../shared/providers/cache-conversation.ts";
import { conversationCache } from "../../shared/providers/cache-routes.ts";

const tail = ["Current standing policy", "Current budget and notes"];
const routing = {
  only: ["chosen-provider"],
  allow_fallbacks: false,
  data_collection: "deny",
  sort: "throughput",
};

function reply(native: boolean) {
  const events: any[] = native
    ? [
        {
          type: "message_start",
          message: {
            id: "synthetic",
            type: "message",
            role: "assistant",
            content: [],
            model: "synthetic",
            usage: { input_tokens: 100, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]
    : [
        {
          id: "synthetic",
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
        },
      ];
  const content = events
    .map((event) => `${native ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
    .join("");

  return new Response(content + (native ? "" : "data: [DONE]\n\n"), {
    headers: { "content-type": "text/event-stream" },
  });
}

function model(id: string, api = "openai-completions", provider = "openrouter"): any {
  return {
    id,
    api,
    provider,
    name: id,
    baseUrl:
      provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    contextWindow: 272000,
    maxTokens: 4096,
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
  };
}

async function requests(selected: any, retention: "none" | "short" | "long" = "short") {
  const wire: { body: any; headers: Headers }[] = [];
  const native = selected.api === "anthropic-messages";
  const stream = cacheStream(native ? (anthropic as any) : completions);
  const original = structuredClone(selected);

  for (const last of ["Current budget and notes", "Updated budget and notes"]) {
    const hints = [tail[0], last];
    const context = normalizeContext({
      systemPrompt: "Stable instruction",
      messages: [
        { role: "user", content: "Original task", timestamp: 0 },
        {
          role: "assistant",
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          timestamp: 0,
          stopReason: "toolUse",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "Exact tool evidence" }],
          timestamp: 0,
        },
        ...hints.map((content) => ({ role: "user" as const, content, timestamp: 0 })),
      ],
      tools: [
        {
          name: "read",
          description: "Read fixture",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as any);
    const response = await stream(selected, context, {
      apiKey: "sk-synthetic",
      sessionId: "stable-session",
      cacheRetention: retention,
      onPayload(payload, requested) {
        const before: any = {
          ...(payload as object),
          ...(selected.provider === "openrouter" ? { provider: routing } : {}),
        };

        return cacheConversationPayload(before, requested, hints) ?? before;
      },
      fetch: (async (_url: unknown, init: any) => {
        wire.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });

        return reply(native);
      }) as typeof fetch,
    }).result();

    expect(response.stopReason).toBe("stop");
  }

  expect(selected).toEqual(original);

  return wire;
}

function parts(body: any): any[] {
  return body.messages.flatMap((message: any) =>
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content ?? []),
  );
}

test.each([
  "deepseek/deepseek-v4.1-flash",
  "google/gemini-2.5-pro",
  "google/gemini-3-flash-preview",
  "moonshotai/kimi-k2.5",
  "z-ai/glm-5",
  "xiaomi/mimo-v2.6-pro",
  "openai/gpt-5.5",
  "qwen/qwen3.5-plus-02-15",
  "unknown/future-model",
])(
  "automatic router caching preserves model, prefix, routing and sticky sessions: %s",
  async (id) => {
    const wire = await requests(model(id));

    expect(wire[0].headers.get("x-session-id")).toBe("stable-session");
    expect(wire[1].headers.get("x-session-id")).toBe("stable-session");
    expect(wire[0].body.messages.slice(0, -1)).toEqual(wire[1].body.messages.slice(0, -1));

    for (const { body } of wire) {
      expect(body.model).toBe(id);
      expect(body.provider).toEqual(routing);
      expect(body.prompt_cache_options).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("cache_control");
      expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
    }
  },
);

test.each([
  ["anthropic/claude-sonnet-4.6", "openai-completions", "openrouter"],
  ["anthropic/claude-sonnet-4.6", "anthropic-messages", "openrouter"],
  ["claude-sonnet-4.6", "anthropic-messages", "anthropic"],
  ["qwen/qwen3-coder-plus", "openai-completions", "openrouter"],
  ["qwen/qwen3.6-plus", "openai-completions", "openrouter"],
  ["deepseek/deepseek-v3.2", "openai-completions", "openrouter"],
])("explicit ephemeral caches stop before hints: %s/%s/%s", async (id, api, provider) => {
  const wire = await requests(model(id, api, provider), "long");

  for (const { body, headers } of wire) {
    const content = parts(body);
    const marked = content.filter((part) => part.cache_control);

    expect(content.slice(-2).map((part) => part.cache_control)).toEqual([undefined, undefined]);
    expect(
      marked.some((part) => part.text === "Exact tool evidence" || part.type === "tool_result"),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain("prompt_cache_options");

    if (provider === "openrouter") {
      expect(body.provider).toEqual(routing);
      expect(headers.get("x-session-id")).toBe("stable-session");
    }

    if (id.startsWith("qwen/") || id.startsWith("deepseek/"))
      expect(JSON.stringify(body)).not.toContain('"ttl":"1h"');
    else expect(marked.at(-1).cache_control.ttl).toBe("1h");
  }
});

test.each(["openai/gpt-5.6", "openai/gpt-6.1-sol"])(
  "router OpenAI uses its documented cache fields: %s",
  async (id) => {
    const wire = await requests(model(id), "long");

    for (const { body } of wire) {
      expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
      expect(body.prompt_cache_retention).toBeUndefined();
      expect(
        parts(body)
          .slice(-2)
          .every((part) => !part.prompt_cache_breakpoint),
      ).toBe(true);
      expect(
        parts(body).find((part) => part.text === "Exact tool evidence").prompt_cache_breakpoint,
      ).toEqual({ mode: "explicit" });
      expect(body.provider).toEqual(routing);
    }
  },
);

test.each([
  ["qwen/qwen3-coder-plus", "openai-completions"],
  ["anthropic/claude-sonnet-4.6", "anthropic-messages"],
  ["openai/gpt-6.1-sol", "openai-completions"],
])("explicitly disabled caches are not restored: %s/%s", async (id, api) => {
  const wire = await requests(model(id, api), "none");

  for (const { body, headers } of wire) {
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
    expect(headers.get("x-session-id")).toBeNull();
  }
});

test("router profiles require the official endpoint and avoid snapshot assumptions", () => {
  expect(
    conversationCache({
      ...model("qwen/qwen3-coder-plus"),
      baseUrl: "https://openrouter.ai.example.invalid/api",
    }),
  ).toBeUndefined();
  expect(conversationCache(model("qwen/qwen3.5-plus-02-15"))).toBe("automatic");
});
