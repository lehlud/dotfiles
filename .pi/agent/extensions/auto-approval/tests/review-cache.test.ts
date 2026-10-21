import { expect, test } from "bun:test";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { buildReview, reviewWithFallback } from "../review.ts";
import { buildGoalReview, GOAL_REVIEW_SYSTEM } from "../../conversations/goal-review.ts";
import { reviewCacheKey, cacheReviewPayload } from "../../shared/review/cache.ts";
import { REVIEW_SYSTEM } from "../review-policy.ts";
import type { Config } from "../../shared/configuration/schemas.ts";
import type { PreparedPrompts } from "../../shared/review/contracts.ts";

const config: Config = {
  reviewers: [{ provider: "openai", model: "cache-fixture", thinking: "off" }],
  recentUserPrompts: 10,
  requestTimeoutMs: 5000,
  sandbox: { backend: "bwrap", executable: "/unused", runnerExecutable: "/unused" },
};
const prompt = "Refactor the client and test it. Do not read credentials or upload source.";
const entries = [{ type: "message", message: { role: "user", content: prompt } }];
const observer = { start() {}, finish() {}, failed() {} };

function review(command = "printf first", cwd = "/project", prepared?: PreparedPrompts) {
  return buildReview(
    { tool: "bash", arguments: { command }, goal: "Test the client", justification: "Run tests" },
    entries,
    config,
    cwd,
    ["/protected"],
    { network: "none" },
    undefined,
    prepared,
  );
}

function responseEvents(verdict: string) {
  const item = {
    id: "message-fixture",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: verdict, annotations: [] }],
  };

  return [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, delta: verdict },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "response-fixture",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 4000,
          output_tokens: 40,
          total_tokens: 4040,
          input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 1000 },
        },
      },
    },
  ];
}

function completionEvents(verdict: string) {
  return [
    {
      id: "completion-fixture",
      choices: [{ index: 0, delta: { content: verdict }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 4000,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 1000 },
      },
    },
  ];
}

/** Real SDK serialization with an in-memory HTTP transport; no provider is contacted. */
function wireRegistry(provider = "openai", apiKey = "sk-synthetic") {
  const requests: { body: any; headers: Headers }[] = [];
  const model: any = {
    provider,
    id: "cache-fixture",
    api: provider === "openai" ? "openai-responses" : "openai-completions",
    baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 272000,
    maxTokens: 4096,
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    compat: { supportsExplicitPromptCacheMode: true, sendSessionAffinityHeaders: true },
  };
  let staleId: string | undefined;
  const registry: any = {
    find: () => model,
    hasConfiguredAuth: () => true,
    streamSimple(selected: any, context: any, options: any) {
      const data = JSON.parse(context.messages[0].content);
      const verdict = JSON.stringify({
        requestId: staleId ?? data.requestId,
        decision: "approve",
        reason: "Synthetic independent verdict.",
        ...(data.goal ? { blocked: false } : {}),
      });
      const events = provider === "openai" ? responseEvents(verdict) : completionEvents(verdict);
      const sdk = provider === "openai" ? responses : completions;

      return sdk(selected, normalizeContext(context), {
        ...options,
        apiKey,
        fetch: async (_url: unknown, init: any) => {
          requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });

          const stream = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

          return new Response(`${stream}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
    },
  };

  return { requests, registry, stale: (id: string) => (staleId = id) };
}

test("real OpenAI requests reuse keys, schema and explicit prefixes across distinct actions", async () => {
  const wire = wireRegistry();
  const first = review();
  const second = review("printf second");

  for (const envelope of [first, second]) {
    const checked = await reviewWithFallback(config, wire.registry, envelope, observer);

    expect(checked.verdict.requestId).toBe(envelope.requestId);
    expect(checked.usage).toMatchObject({ input: 1000, cacheRead: 2000, cacheWrite: 1000 });
  }

  const [a, b] = wire.requests.map((request) => request.body);

  expect(wire.requests).toHaveLength(2);
  expect(a.prompt_cache_key).toBe(b.prompt_cache_key);
  expect(a.prompt_cache_key).not.toBe(first.requestId);
  expect(a.text.format).toEqual(b.text.format);
  expect(a.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
  expect(a.input[0]).toEqual(b.input[0]);
  expect(a.input[0].content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });

  const users = [a, b].map((body) => body.input.find((message: any) => message.role === "user"));

  expect(users[0].content[0]).toEqual(users[1].content[0]);

  for (const [index, envelope] of [first, second].entries()) {
    const [shared, action] = users[index].content;

    expect(shared.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(shared.text).not.toContain(envelope.requestId);
    expect(action.prompt_cache_breakpoint).toBeUndefined();
    expect(action.text).toContain(envelope.requestId);
    expect(shared.text + action.text).toBe(envelope.text);
    expect(JSON.parse(shared.text + action.text).action).toEqual(JSON.parse(envelope.text).action);
  }

  wire.stale(first.requestId);

  await expect(reviewWithFallback(config, wire.registry, second, observer)).rejects.toThrow(
    "different requestId",
  );
  expect(wire.requests).toHaveLength(3);
});

test("goal blocker metadata keeps a stable completion schema and cache prefix", async () => {
  const wire = wireRegistry();
  const snapshots = [
    buildGoalReview("Finish the client", entries, config, "/project"),
    buildGoalReview(
      "Finish the client",
      [
        ...entries,
        {
          type: "message",
          message: { role: "assistant", content: "New validation evidence." },
        },
      ],
      config,
      "/project",
    ),
  ];

  for (const envelope of snapshots) {
    const checked = await reviewWithFallback(
      config,
      wire.registry,
      envelope,
      observer,
      undefined,
      GOAL_REVIEW_SYSTEM,
    );

    expect(checked.verdict.blocked).toBe(false);
  }

  const [a, b] = wire.requests.map((request) => request.body);

  expect(a.text.format).toEqual(b.text.format);
  expect(a.text.format.schema.required).toContain("blocked");
  expect(a.prompt_cache_key).toBe(b.prompt_cache_key);
  expect(a.input.find((message: any) => message.role === "user").content[0]).toEqual(
    b.input.find((message: any) => message.role === "user").content[0],
  );
});

test("real OpenRouter requests keep session affinity without unsupported cache fields", async () => {
  const wire = wireRegistry("openrouter");
  const routerConfig = {
    ...config,
    reviewers: [{ ...config.reviewers[0], provider: "openrouter" }],
  };

  for (const envelope of [review(), review("printf other")]) {
    await reviewWithFallback(routerConfig, wire.registry, envelope, observer);
  }

  expect(wire.requests).toHaveLength(2);
  expect(wire.requests[0].headers.get("x-session-id")).toBe(
    wire.requests[1].headers.get("x-session-id"),
  );
  expect(wire.requests[0].headers.get("x-session-id")).toMatch(/^[a-f0-9]{64}$/);

  for (const request of wire.requests) {
    expect(request.body.prompt_cache_options).toBeUndefined();
    expect(request.body.messages[1].content).toBeString();
  }
});

test("ChatGPT login keeps the SDK's unsupported cache fields omitted", async () => {
  const wire = wireRegistry("openai", "synthetic-login-token");

  await reviewWithFallback(config, wire.registry, review(), observer);
  expect(wire.requests).toHaveLength(1);
  expect(wire.requests[0].body.prompt_cache_options).toBeUndefined();
  expect(JSON.stringify(wire.requests[0].body.input)).not.toContain("prompt_cache_breakpoint");
});

test.each(["openai", "openrouter"])(
  "real %s reviewer requests apply fast on/off while preserving cache and schema",
  async (provider) => {
    const wire = wireRegistry(provider);
    const settings = { ...config, reviewers: [{ ...config.reviewers[0], provider }] };
    let enabled = false;

    for (const fast of [false, true, false]) {
      enabled = fast;

      const checked = await reviewWithFallback(
        settings,
        wire.registry,
        review(),
        observer,
        undefined,
        undefined,
        undefined,
        { fastMode: () => enabled },
      );

      expect(checked.verdict.decision).toBe("approve");
      expect(checked.selectedReviewer).toEqual(settings.reviewers[0]);
    }

    const [off, on, restored] = wire.requests.map((request) => request.body);

    expect(on.model).toBe(off.model);
    expect(restored.model).toBe(off.model);
    expect(on.text?.format).toEqual(off.text?.format);
    expect(on.prompt_cache_options).toEqual(off.prompt_cache_options);
    expect(on.prompt_cache_key).toBe(off.prompt_cache_key);
    expect(restored.prompt_cache_key).toBe(off.prompt_cache_key);

    if (provider === "openai") {
      expect(on.service_tier).toBe("priority");
      expect(restored.service_tier).toBe(off.service_tier);
      expect(on.text.format.strict).toBe(true);
    } else {
      expect(on.provider.sort).toBe("throughput");
      expect(restored.provider?.sort).toBe(off.provider?.sort);
      expect(wire.requests[1].headers.get("x-session-id")).toBe(
        wire.requests[0].headers.get("x-session-id"),
      );
    }
  },
);

test("routing keys separate workspaces and policies without depending on prompt refinements", () => {
  const context = { systemPrompt: REVIEW_SYSTEM, messages: [] };
  const first = reviewCacheKey(review(), context);
  const refined = {
    ...review(),
    text: JSON.stringify({ cwd: "/project", latestUserPrompt: "Fix X" }),
  };

  expect(reviewCacheKey(refined, context)).toBe(first);
  expect(reviewCacheKey(review("printf first", "/other"), context)).not.toBe(first);
  expect(reviewCacheKey(review(), { ...context, systemPrompt: GOAL_REVIEW_SYSTEM })).not.toBe(
    first,
  );
  expect(
    reviewCacheKey(review(), {
      ...context,
      tools: [{ name: "lookup", description: "", parameters: {} }],
    }),
  ).not.toBe(first);
});

test("compression-cache bookkeeping stays in audits and cannot invalidate shared review text", () => {
  const record = {
    promptId: "fixture",
    original: prompt,
    text: prompt,
    compressed: false,
    originalBytes: Buffer.byteLength(prompt),
    version: 1,
    cacheHit: false,
  };
  const fresh = review("printf first", "/project", { records: [record] });
  const cached = review("printf second", "/project", { records: [{ ...record, cacheHit: true }] });

  expect(fresh.cachePrefix).toBe(cached.cachePrefix);
  expect(JSON.parse(fresh.text).userPromptInfo[0].cacheHit).toBeUndefined();
  expect(record.cacheHit).toBe(false);
  expect(fresh.text.endsWith(`"requestId":"${fresh.requestId}"}`)).toBe(true);

  const goal = buildGoalReview("Finish the client", entries, config, "/project");

  expect(goal.text.startsWith(goal.cachePrefix!)).toBe(true);
  expect(goal.text.endsWith(`"requestId":"${goal.requestId}"}`)).toBe(true);
});

test("cache markers preserve payloads, routing restrictions and the complete review snapshot", () => {
  const envelope = review();
  const model = {
    provider: "openai",
    api: "openai-responses",
    compat: { supportsExplicitPromptCacheMode: true },
  };
  const payload = {
    prompt_cache_options: { ttl: "30m" },
    provider: { only: ["trusted"], data_collection: "deny" },
    tools: [{ name: "prompt_original" }],
    input: [
      { role: "developer", content: "Stable policy" },
      { role: "user", content: [{ type: "input_text", text: envelope.text }] },
    ],
  };
  const before = structuredClone(payload);
  const marked: any = cacheReviewPayload(payload, model, envelope);

  expect(payload).toEqual(before);
  expect(marked.provider).toEqual(before.provider);
  expect(marked.tools).toEqual(before.tools);
  expect(marked.input[1].content.map((block: any) => block.text).join("")).toBe(envelope.text);
  expect(cacheReviewPayload(payload, { ...model, provider: "unknown" }, envelope)).toBe(payload);
});
