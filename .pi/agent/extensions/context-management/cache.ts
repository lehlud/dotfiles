import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";

type CacheModel = {
  id: string;
  provider: string;
  api: string;
  baseUrl?: string;
  compat?: unknown;
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Capture only the contiguous custom-message suffix, never operator text in history. */
export function cacheTail(messages: readonly { role: string; content?: unknown }[]): string[] {
  const tail: string[] = [];

  for (const message of [...messages].reverse()) {
    if (message.role !== "custom" || typeof message.content !== "string") break;

    tail.unshift(sanitizeSurrogates(message.content));
  }

  return tail;
}

function supported(model: CacheModel | undefined, body: RecordValue) {
  if (
    model?.provider !== "openai" ||
    model.api !== "openai-responses" ||
    !record(model.compat) ||
    model.compat.supportsExplicitPromptCacheMode !== true
  )
    return false;

  try {
    const url = new URL(model.baseUrl ?? "");

    // The SDK omits the output cap for ChatGPT login. Never restore its rejected fields.
    return (
      url.origin === "https://api.openai.com" &&
      body.model === model.id &&
      typeof body.max_output_tokens === "number" &&
      body.max_output_tokens > 0 &&
      Number.isFinite(body.max_output_tokens) &&
      typeof body.prompt_cache_key === "string" &&
      body.prompt_cache_key.length > 0
    );
  } catch {
    return false;
  }
}

function textMessage(item: unknown, text: string) {
  return (
    record(item) &&
    item.role === "user" &&
    Array.isArray(item.content) &&
    item.content.length === 1 &&
    record(item.content[0]) &&
    item.content[0].type === "input_text" &&
    item.content[0].text === text
  );
}

function boundary(input: unknown[], tail: readonly string[]): number {
  if (!tail.length) return -1;

  const end = input.findLastIndex((item) => textMessage(item, tail.at(-1)!));
  const start = end - tail.length + 1;

  return start >= 0 && tail.every((text, index) => textMessage(input[start + index], text))
    ? start
    : -1;
}

function hasBreakpoint(item: unknown) {
  if (!record(item)) return false;

  return [item.content, item.output].some(
    (value) =>
      Array.isArray(value) &&
      value.some((part) => record(part) && part.prompt_cache_breakpoint !== undefined),
  );
}

/** Preserve history boundaries so the next request can still look up earlier cache writes. */
function mark(item: unknown): unknown {
  if (!record(item)) return item;

  const field = ["function_call_output", "custom_tool_call_output"].includes(String(item.type))
    ? "output"
    : ["user", "system", "developer"].includes(String(item.role))
      ? "content"
      : null;

  if (!field) return item;

  const value = item[field];
  const parts = typeof value === "string" ? [{ type: "input_text", text: value }] : value;

  if (!Array.isArray(parts) || !parts.length) return item;

  const last = parts.at(-1);

  if (!record(last) || !["input_text", "input_image", "input_file"].includes(String(last.type)))
    return item;

  return {
    ...item,
    [field]: [
      ...parts.slice(0, -1),
      {
        ...last,
        prompt_cache_breakpoint: { mode: "explicit" },
      },
    ],
  };
}

/** Cache the growing history, excluding per-request policy, budget and notes messages. */
export function cacheContextPayload(
  payload: unknown,
  model: CacheModel | undefined,
  tail: readonly string[],
) {
  if (!record(payload) || !supported(model, payload) || !Array.isArray(payload.input)) return;

  const options = payload.prompt_cache_options;

  // Respect explicit caller policy, existing breakpoints and unknown option shapes.
  if (
    options !== undefined &&
    (!record(options) || ![undefined, "implicit"].includes(options.mode as string | undefined))
  )
    return;

  if (payload.input.some(hasBreakpoint)) return;

  const end = boundary(payload.input, tail);

  if (end <= 0) return;

  const original = payload.input;
  const input = original.map((item, index) => (index < end ? mark(item) : item));

  if (!input.some((item, index) => item !== original[index])) return;

  return { ...payload, input, prompt_cache_options: { ...(options ?? {}), mode: "explicit" } };
}
