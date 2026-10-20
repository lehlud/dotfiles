import { expect, test } from "bun:test";
import { cachePayload } from "../../shared/providers/cache-affinity.ts";

const model = {
  provider: "openai",
  api: "openai-responses",
  id: "working",
  baseUrl: "https://api.openai.com/v1",
};
const lineage = { provider: model.provider, api: model.api, model: model.id, key: "parent-key" };

test("related OpenAI requests share only the cache key while preserving payload and transport identity", () => {
  const body = {
    model: "working",
    prompt_cache_key: "child-id",
    previous_response_id: "own-response",
    metadata: { session_id: "child-id" },
    input: ["own transcript"],
    tools: ["own tools"],
    service_tier: "priority",
  };
  const selected = cachePayload(body, model, "child-id", lineage);

  expect(selected.payload).toEqual({ ...body, prompt_cache_key: "parent-key" });
  expect(selected.lineage).toEqual(lineage);
  expect(body.prompt_cache_key).toBe("child-id");
  expect(selected.payload?.metadata).toEqual({ session_id: "child-id" });
  expect(selected.payload?.previous_response_id).toBe("own-response");
});

test("explicit cache keys, disabled caching and incompatible models/providers are preserved", () => {
  expect(
    cachePayload(
      { model: "working", prompt_cache_key: "operator-choice" },
      model,
      "child-id",
      lineage,
    ),
  ).toMatchObject({ payload: undefined, lineage: { key: "operator-choice" } });
  expect(cachePayload({ model: "working" }, model, "child-id", lineage)).toEqual({});
  expect(
    cachePayload({ model: "working", prompt_cache_key: undefined }, model, "child-id", lineage),
  ).toEqual({});

  for (const changed of [
    { ...lineage, model: "different" },
    { ...lineage, provider: "openrouter" },
    { ...lineage, api: "openai-completions" },
  ])
    expect(
      cachePayload({ model: "working", prompt_cache_key: "child-id" }, model, "child-id", changed),
    ).toMatchObject({ payload: undefined, lineage: { key: "child-id" } });
});

test("cache parameters are never added to unverified routes or unrelated provider APIs", () => {
  const body = { model: "working", prompt_cache_key: "child-id" };

  for (const changed of [
    { ...model, provider: "openrouter" },
    { ...model, api: "anthropic-messages" },
    { ...model, baseUrl: "https://proxy.invalid" },
    { ...model, baseUrl: "http://api.openai.com" },
    { ...model, baseUrl: "https://api.openai.com.evil.invalid" },
  ])
    expect(cachePayload(body, changed, "child-id", lineage)).toEqual({});
});
