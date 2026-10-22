import { cacheRecord as record, conversationCache, type CacheModel } from "./cache-routes.ts";

type Block = { message: number; part: number; value: Record<string, unknown> };

function messages(body: Record<string, unknown>) {
  if (!Array.isArray(body.messages)) return;

  return body.messages.map((item) => {
    if (!record(item)) return item;

    const content =
      typeof item.content === "string" && item.content.length
        ? [{ type: "text", text: item.content }]
        : item.content;

    return {
      ...item,
      ...(Array.isArray(content)
        ? { content: content.map((part) => (record(part) ? { ...part } : part)) }
        : {}),
    };
  });
}

function blocks(items: unknown[]): Block[] {
  return items.flatMap((item, message) =>
    record(item) && Array.isArray(item.content)
      ? item.content.flatMap((value, part) => (record(value) ? [{ message, part, value }] : []))
      : [],
  );
}

function cutAt(items: unknown[], parts: Block[], tail: readonly string[]) {
  if (!tail.length) return -1;

  const end = parts.findLastIndex(
    ({ value }) => value.type === "text" && value.text === tail.at(-1),
  );
  const start = end - tail.length + 1;

  return start >= 0 &&
    tail.every((text, index) => {
      const block = parts[start + index];
      const item = items[block.message];

      return (
        record(item) &&
        item.role === "user" &&
        block.value.type === "text" &&
        block.value.text === text
      );
    })
    ? start
    : -1;
}

function ephemeral(parts: Block[], end: number) {
  const marked = parts.slice(end).filter(({ value }) => value.cache_control !== undefined);
  const control = marked[0]?.value.cache_control;
  const target = parts
    .slice(0, end)
    .findLast(({ value }) =>
      ["text", "image", "document", "tool_result", "tool_addition", "tool_removal"].includes(
        String(value.type),
      ),
    );

  // Only relocate the SDK's enabled suffix marker; disabled caching stays disabled.
  if (marked.length !== 1 || !record(control) || control.type !== "ephemeral" || !target)
    return false;

  delete marked[0].value.cache_control;
  target.value.cache_control ??= { ...control };

  return true;
}

function explicit(body: Record<string, unknown>, parts: Block[], end: number) {
  const options = body.prompt_cache_options;

  if (
    !record(options) ||
    options.mode !== "implicit" ||
    parts.some(
      ({ value }) =>
        value.prompt_cache_breakpoint !== undefined || value.cache_control !== undefined,
    )
  )
    return;

  const targets = parts.slice(0, end).filter(({ value }) => value.type === "text");

  if (!targets.length) return;

  for (const { value } of targets) value.prompt_cache_breakpoint = { mode: "explicit" };

  return { ...options, mode: "explicit" };
}

/** Protocol-specific markers share one stable-prefix boundary across router/native routes. */
export function cacheConversationPayload(
  payload: unknown,
  model: CacheModel | undefined,
  tail: readonly string[],
) {
  if (
    !model ||
    !record(payload) ||
    payload.model !== model.id ||
    payload.cache_control !== undefined
  )
    return;

  const strategy = conversationCache(model);

  if (!strategy || strategy === "automatic") return;

  const items = messages(payload);

  if (!items) return;

  const parts = blocks(items);
  const end = cutAt(items, parts, tail);

  if (end <= 0) return;

  if (strategy === "ephemeral")
    return ephemeral(parts, end) ? { ...payload, messages: items } : undefined;

  const options = explicit(payload, parts, end);

  return options ? { ...payload, messages: items, prompt_cache_options: options } : undefined;
}

/** Split a reviewed JSON block without changing its text, then cache only its shared prefix. */
export function cacheConversationReview(
  payload: unknown,
  model: CacheModel,
  text: string,
  prefix?: string,
) {
  if (!prefix || !text.startsWith(prefix) || !record(payload)) return;

  const strategy = conversationCache(model);

  if (!strategy || strategy === "automatic") return;

  const items = messages(payload);

  if (!items) return;

  const target = blocks(items).find(({ value }) => value.type === "text" && value.text === text);

  if (!target) return;

  const item = items[target.message];

  if (!record(item) || !Array.isArray(item.content)) return;

  const suffix = text.slice(prefix.length);

  item.content.splice(
    target.part,
    1,
    { type: "text", text: prefix },
    { ...target.value, text: suffix },
  );

  return cacheConversationPayload({ ...payload, messages: items }, model, [suffix]);
}
