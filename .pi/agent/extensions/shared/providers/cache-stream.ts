import type { Provider } from "@earendil-works/pi-ai";
import { alibabaCache, cacheRecord, conversationCache } from "./cache-routes.ts";

type Stream = Provider["streamSimple"];

/** Negotiate documented router cache fields before existing request hooks run. */
export function cacheStream(original: Stream): Stream {
  return (model, context, options) => {
    const compat = cacheRecord(model.compat) ? model.compat : {};
    const selected =
      alibabaCache(model) &&
      model.api === "openai-completions" &&
      compat.cacheControlFormat === undefined
        ? {
            ...model,
            compat: {
              ...compat,
              cacheControlFormat: "anthropic" as const,
              supportsLongCacheRetention: false,
            },
          }
        : model;

    if (conversationCache(selected) !== "openai") return original(selected, context, options);

    return original(selected, context, {
      ...options,
      onPayload: async (payload, requested) => {
        const prepared =
          cacheRecord(payload) && payload.prompt_cache_options === undefined
            ? {
                ...payload,
                prompt_cache_retention: undefined,
                prompt_cache_options: {
                  mode: options?.cacheRetention === "none" ? "explicit" : "implicit",
                  ...(options?.cacheRetention === "long" ? { ttl: "30m" } : {}),
                },
              }
            : payload;

        return (await options?.onPayload?.(prepared, requested)) ?? prepared;
      },
    });
  };
}
