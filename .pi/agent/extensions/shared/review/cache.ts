import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import type { ReviewEnvelope } from "./contracts.ts";
import { cacheConversationReview } from "../providers/cache-conversation.ts";
import { conversationCache, isOpenRouter } from "../providers/cache-routes.ts";

type CacheModel = {
  provider: string;
  api?: string;
  id?: string;
  baseUrl?: string;
  compat?: unknown;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Cache routing is scoped to the workspace and review policy, never an approval ID. */
export function reviewCacheKey(envelope: ReviewEnvelope, context: Context): string {
  const { cwd } = JSON.parse(envelope.text);

  return createHash("sha256")
    .update(
      JSON.stringify(["pi-review-v1", cwd ?? null, context.systemPrompt, context.tools ?? []]),
    )
    .digest("hex");
}

export function reviewCacheRetention(model: CacheModel): "short" | "long" {
  if (
    model.api === "openai-responses" &&
    isOpenRouter(model) &&
    conversationCache(model) === "openai"
  )
    return "long";

  const explicit =
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    object(model.compat) &&
    model.compat.supportsExplicitPromptCacheMode === true;

  // The SDK negotiates the supported 30-minute TTL and omits it for ChatGPT login.
  return explicit ? "long" : "short";
}

function cachedText(text: string) {
  return { type: "input_text", text, prompt_cache_breakpoint: { mode: "explicit" } };
}

function markMessage(message: unknown, envelope: ReviewEnvelope): unknown {
  if (!object(message)) return message;

  if (
    ["system", "developer"].includes(String(message.role)) &&
    typeof message.content === "string"
  ) {
    return { ...message, content: [cachedText(message.content)] };
  }

  const prefix = envelope.cachePrefix;

  if (
    message.role !== "user" ||
    !Array.isArray(message.content) ||
    !prefix ||
    !envelope.text.startsWith(prefix)
  ) {
    return message;
  }

  const content = message.content.flatMap((part: unknown) => {
    if (!object(part) || part.type !== "input_text" || part.text !== envelope.text) return [part];

    // Concatenation remains the exact reviewed JSON, including its unique request ID.
    return [cachedText(prefix), { ...part, text: envelope.text.slice(prefix.length) }];
  });

  return { ...message, content };
}

/** Keep one-off actions and receipts outside explicit OpenAI cache writes. */
export function cacheReviewPayload(
  payload: unknown,
  model: CacheModel,
  envelope: ReviewEnvelope,
): unknown {
  const routed = cacheConversationReview(payload, model, envelope.text, envelope.cachePrefix);

  if (routed) return routed;

  if (
    reviewCacheRetention(model) !== "long" ||
    !object(payload) ||
    !object(payload.prompt_cache_options) ||
    !Array.isArray(payload.input)
  ) {
    return payload;
  }

  // Require the SDK's negotiated options; never reintroduce fields it omitted for login.
  return {
    ...payload,
    prompt_cache_options: { ...payload.prompt_cache_options, mode: "explicit" },
    input: payload.input.map((message) => markMessage(message, envelope)),
  };
}
