import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionServices } from "../session/services.ts";

type SelectedModel = { provider: string; api: string };

export function fastRoute(model?: SelectedModel): "priority" | "throughput" | undefined {
  if (!model) {
    return undefined;
  }

  if (model.provider === "openrouter" && model.api === "openai-completions") {
    return "throughput";
  }

  if (
    ["openai", "openai-codex"].includes(model.provider) &&
    ["openai-responses", "openai-codex-responses", "openai-completions"].includes(model.api)
  ) {
    return "priority";
  }

  return undefined;
}

/** Change only request speed preferences; preserve model, tools and routing restrictions. */
export function fastPayload(payload: unknown, model: SelectedModel | undefined, enabled: boolean) {
  const route = enabled ? fastRoute(model) : undefined;

  if (!route || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }

  const body = payload as Record<string, unknown>;

  if (route === "priority") {
    return { ...body, service_tier: "priority" };
  }

  const provider = body.provider;

  if (
    provider !== undefined &&
    (!provider || typeof provider !== "object" || Array.isArray(provider))
  ) {
    throw new Error("Fast mode cannot preserve invalid OpenRouter provider preferences");
  }

  return { ...body, provider: { ...(provider ?? {}), sort: "throughput" } };
}

export function registerFastRequests(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) =>
    fastPayload(event.payload, ctx.model, sessionServices(ctx).fastMode?.() ?? false),
  );
}
