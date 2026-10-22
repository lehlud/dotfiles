export type CacheModel = {
  provider: string;
  api?: string;
  id?: string;
  baseUrl?: string;
  compat?: unknown;
};

export function cacheRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOpenRouter(model: CacheModel) {
  try {
    return (
      model.provider === "openrouter" &&
      new URL(model.baseUrl ?? "").origin === "https://openrouter.ai"
    );
  } catch {
    return false;
  }
}

// OpenRouter documents explicit Alibaba caching for these canonical endpoints,
// excluding dated snapshots. Other Qwen routes retain automatic provider behavior.
const alibabaCaching = new Set([
  "deepseek/deepseek-v3.2",
  "qwen/qwen3-max",
  "qwen/qwen-plus",
  "qwen/qwen3.6-plus",
  "qwen/qwen3-coder-plus",
  "qwen/qwen3-coder-flash",
]);

export function alibabaCache(model: CacheModel) {
  return isOpenRouter(model) && alibabaCaching.has(model.id?.split(":")[0] ?? "");
}

export function conversationCache(
  model: CacheModel,
): "openai" | "ephemeral" | "automatic" | undefined {
  if (model.api === "anthropic-messages") return "ephemeral";

  if (!isOpenRouter(model) || !["openai-completions", "openai-responses"].includes(model.api ?? ""))
    return;

  const id = model.id ?? "";
  const version = /^openai\/gpt-(\d+)(?:\.(\d+))?(?:[-:]|$)/.exec(id);

  if (version && (+version[1] > 5 || (+version[1] === 5 && +(version[2] ?? 0) >= 6)))
    return "openai";

  if (model.api === "openai-responses") return "automatic";

  if (
    id.startsWith("anthropic/") ||
    alibabaCache(model) ||
    (cacheRecord(model.compat) && model.compat.cacheControlFormat === "anthropic")
  )
    return "ephemeral";

  return "automatic";
}
