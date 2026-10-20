import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SelectedModel = {
  api: string;
  provider: string;
  baseUrl?: string;
  contextWindow: number;
  maxTokens: number;
};

export function profile(model?: SelectedModel) {
  if (model?.api === "anthropic-messages") return "signed-history";

  if (model?.api.includes("google")) return "signed-history";

  if (model?.api === "openai-responses" || model?.api === "openai-codex-responses")
    return "responses";

  return "portable";
}

/** All counts include cached input; cached tokens still occupy the context window. */
export function budget(ctx: Pick<ExtensionContext, "getContextUsage" | "model">) {
  const usage = ctx.getContextUsage();
  const window = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
  const reserve = Math.min(
    Math.floor(window / 3),
    Math.max(4096, Math.min(ctx.model?.maxTokens ?? 4096, 16384)),
  );
  const used = usage?.tokens ?? null;

  return {
    profile: profile(ctx.model),
    window,
    reserve,
    used,
    available: used === null ? null : Math.max(0, window - reserve - used),
    pressure: used !== null && window > 0 && used >= (window - reserve) * 0.75,
  };
}
