import { expect, test } from "bun:test";
import { cacheContextPayload, cacheTail } from "../../context-management/cache.ts";
import contextManagement from "../../context-management/index.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const model = {
  id: "working",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  compat: { supportsExplicitPromptCacheMode: true },
};
const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const policy = ["Standing code policy", "Budget: changing; notes: changing"];
const body = () => ({
  model: "working",
  max_output_tokens: 4096,
  prompt_cache_key: "session",
  tools: [{ type: "function", name: "read" }],
  service_tier: "priority",
  store: false,
  input: [
    { role: "developer", content: "Stable instructions" },
    user("Task"),
    { type: "function_call", call_id: "call", name: "read", arguments: "{}" },
    { type: "reasoning", encrypted_content: "opaque" },
    { type: "function_call_output", call_id: "call", output: "Exact evidence" },
    ...policy.map(user),
  ],
});

test("native tool clearing composes with relocated cache markers", () => {
  const hooks: Record<string, Function> = {};
  const manager = SessionManager.inMemory("/fixture");

  manager.appendCustomEntry("context-memory-settings", { native: true });
  contextManagement({
    on(name: string, callback: Function) {
      hooks[name] = callback;
    },
    registerCommand() {},
    registerTool() {},
  } as any);

  const ctx: any = {
    sessionManager: manager,
    model: {
      id: "claude-fixture",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200000,
      maxTokens: 4096,
    },
    getContextUsage: () => ({ tokens: 100 }),
  };

  hooks.session_start({}, ctx);

  const projection = hooks.context({ messages: [{ role: "user", content: "Task" }] }, ctx);
  const content = projection.messages.map((message: any) => ({
    type: "text",
    text: message.content,
  }));

  content.at(-1).cache_control = { type: "ephemeral" };

  const changed = hooks.before_provider_request(
    {
      payload: {
        model: "claude-fixture",
        tools: [{ name: "history" }],
        messages: [{ role: "user", content }],
      },
    },
    ctx,
  );

  expect(changed.context_management.edits[0].type).toBe("clear_tool_uses_20250919");
  expect(changed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  expect(changed.messages[0].content.at(-1).cache_control).toBeUndefined();
});

test("cache tail comes from custom suffix metadata, including Unicode normalization", () => {
  expect(
    cacheTail([
      { role: "custom", content: "Saved peer message" },
      { role: "user", content: "Budget: user quotation" },
      { role: "custom", content: "policy\ud800" },
    ]),
  ).toEqual(["policy"]);
  expect(cacheTail([{ role: "user", content: "ordinary input" }])).toEqual([]);
});

test("cache writes cover stable history and tool evidence, preserving requests and saved objects", () => {
  const request = body();
  const original = structuredClone(request);
  const changed: any = cacheContextPayload(request, model, policy);

  expect(request).toEqual(original);
  expect({ ...changed, input: undefined }).toEqual({
    ...original,
    input: undefined,
    prompt_cache_options: { mode: "explicit" },
  });
  expect(changed.input[0].content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
  expect(changed.input[4].output).toEqual([
    { type: "input_text", text: "Exact evidence", prompt_cache_breakpoint: { mode: "explicit" } },
  ]);
  expect(changed.input.slice(2, 4)).toEqual(original.input.slice(2, 4));
  expect(changed.input.slice(-2)).toEqual(original.input.slice(-2));
});

test("earlier cache boundaries survive a growing conversation and different transient data", () => {
  const first: any = cacheContextPayload(body(), model, policy);
  const next = {
    ...body(),
    input: [...body().input.slice(0, -2), user("Follow up"), user("new budget")],
  };
  const second: any = cacheContextPayload(next, model, ["new budget"]);

  expect(second.input.slice(0, first.input.length - 2)).toEqual(first.input.slice(0, -2));
  expect(second.input.at(-2).content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
  expect(second.input.at(-1)).toEqual(user("new budget"));
});

test.each([
  { ...model, provider: "openrouter" },
  { ...model, provider: "openai-codex", api: "openai-codex-responses" },
  { ...model, api: "openai-completions" },
  { ...model, baseUrl: "https://api.openai.com.example.invalid/v1" },
  { ...model, baseUrl: "http://api.openai.com/v1" },
  { ...model, compat: { supportsExplicitPromptCacheMode: false } },
])("unnegotiated or nonofficial routes receive no cache fields: %j", (selected) => {
  expect(cacheContextPayload(body(), selected, policy)).toBeUndefined();
});

test("caller caching policy and SDK login/disabled-cache omissions are respected", () => {
  for (const patch of [
    { model: "other-model" },
    { max_output_tokens: undefined },
    { prompt_cache_key: undefined },
    { prompt_cache_options: { mode: "explicit" } },
    { prompt_cache_options: null },
  ])
    expect(cacheContextPayload({ ...body(), ...patch }, model, policy)).toBeUndefined();

  const marked = {
    ...body(),
    input: [
      {
        ...user("other"),
        content: [
          { type: "input_text", text: "other", prompt_cache_breakpoint: { mode: "explicit" } },
        ],
      },
      ...body().input,
    ],
  };

  expect(cacheContextPayload(marked, model, policy)).toBeUndefined();
  expect(cacheContextPayload(body(), model, ["mismatched suffix"])).toBeUndefined();
  expect(cacheContextPayload(body(), model, [])).toBeUndefined();
  expect(
    cacheContextPayload(
      { ...body(), prompt_cache_options: { ttl: "12h", mode: "implicit" } },
      model,
      policy,
    ),
  ).toMatchObject({ prompt_cache_options: { ttl: "12h", mode: "explicit" } });
});

test("structured custom-tool evidence and images retain their exact data", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" };
  const evidence = {
    type: "custom_tool_call_output",
    call_id: "custom",
    output: [{ type: "input_text", text: "unchanged" }, image],
  };
  const request = { ...body(), input: [evidence, ...policy.map(user)] };
  const original = structuredClone(request);
  const changed: any = cacheContextPayload(request, model, policy);

  expect(request).toEqual(original);
  expect(changed.input[0].output[0]).toEqual(evidence.output[0]);
  expect(changed.input[0].output[1]).toEqual({
    ...image,
    prompt_cache_breakpoint: { mode: "explicit" },
  });
});
