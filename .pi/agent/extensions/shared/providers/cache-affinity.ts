import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionServices } from "../session/services.ts";

export const CACHE_LINEAGE = "provider-cache-lineage";

export type CacheLineage = { provider: string; api: string; model: string; key: string };

type SelectedModel = { provider: string; api: string; id: string; baseUrl: string };

function supported(model: SelectedModel | undefined): model is SelectedModel {
  if (
    !model ||
    !["openai", "openai-codex"].includes(model.provider) ||
    !["openai-responses", "openai-codex-responses", "openai-completions"].includes(model.api)
  )
    return false;

  try {
    const url = new URL(model.baseUrl);

    return (
      url.protocol === "https:" &&
      !url.port &&
      ["api.openai.com", "chatgpt.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Inherit only the cache hint; provider routing, transport and lifecycle remain independent. */
export function cachePayload(
  payload: unknown,
  model: SelectedModel | undefined,
  sessionId: string,
  inherited?: CacheLineage,
): { lineage?: CacheLineage; payload?: Record<string, unknown> } {
  if (!supported(model) || !payload || typeof payload !== "object" || Array.isArray(payload))
    return {};

  const body = payload as Record<string, unknown>;
  const original = body.prompt_cache_key;

  // No key can mean caching was explicitly disabled. Never silently turn it on.
  if (
    typeof original !== "string" ||
    !original.length ||
    original.length > 64 ||
    body.model !== model.id
  )
    return {};

  const sameModel =
    inherited?.provider === model.provider &&
    inherited.api === model.api &&
    inherited.model === model.id;
  const candidate = inherited?.key ?? "";
  const key =
    original === sessionId && sameModel && candidate.length > 0 && candidate.length <= 64
      ? candidate
      : original;

  return {
    lineage: { provider: model.provider, api: model.api, model: model.id, key },
    payload: key === original ? undefined : { ...body, prompt_cache_key: key },
  };
}

/** Persist the family hint as private metadata, outside the model transcript and action policy. */
export function registerCacheAffinity(pi: ExtensionAPI) {
  let current: CacheLineage | undefined;
  const bind = (_event: unknown, ctx: ExtensionContext) => {
    const entry = ctx.sessionManager
      .getBranch()
      .findLast((item) => item.type === "custom" && item.customType === CACHE_LINEAGE);
    const saved = entry?.type === "custom" ? (entry.data as CacheLineage) : undefined;

    current =
      saved &&
      [saved.provider, saved.api, saved.model, saved.key].every(
        (value) => typeof value === "string",
      )
        ? saved
        : undefined;
    sessionServices(ctx).cacheLineage = () => current;
  };

  pi.on("session_start", bind);
  pi.on("session_tree", bind);
  pi.on("session_shutdown", () => {
    current = undefined;
  });
  pi.on("before_provider_request", (event, ctx) => {
    const inherited = sessionServices(ctx).parentCacheLineage?.() ?? current;
    const selected = cachePayload(
      event.payload,
      ctx.model,
      ctx.sessionManager.getSessionId(),
      inherited,
    );

    if (selected.lineage && JSON.stringify(selected.lineage) !== JSON.stringify(current))
      pi.appendEntry(CACHE_LINEAGE, selected.lineage);

    current = selected.lineage;

    return selected.payload;
  });
}
