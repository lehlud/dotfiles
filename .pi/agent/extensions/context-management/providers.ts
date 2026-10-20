import type { SelectedModel } from "./budget.ts";

/** A beta feature is opt-in and only goes to the direct, official Anthropic endpoint. */
export function nativeToolClearing(model: SelectedModel | undefined, enabled: boolean) {
  if (!enabled || model?.provider !== "anthropic" || model.api !== "anthropic-messages")
    return false;

  try {
    const url = new URL(model.baseUrl ?? "");

    return url.protocol === "https:" && url.hostname === "api.anthropic.com" && !url.port;
  } catch {
    return false;
  }
}

export function nativeHeaders(
  headers: Record<string, string | null>,
  model: SelectedModel | undefined,
  enabled: boolean,
) {
  if (!nativeToolClearing(model, enabled)) return;

  const key =
    Object.keys(headers).find((name) => name.toLowerCase() === "anthropic-beta") ??
    "anthropic-beta";

  if (headers[key] === null)
    throw new Error(
      "Native tool clearing conflicts with explicit anthropic-beta header suppression; disable native clearing or resolve the header setting",
    );

  const values = new Set(
    (headers[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  values.add("context-management-2025-06-27");
  headers[key] = [...values].join(",");
}

export function nativePayload(
  payload: unknown,
  model: SelectedModel | undefined,
  enabled: boolean,
) {
  if (!nativeToolClearing(model, enabled) || !payload || typeof payload !== "object") return;

  const body = payload as Record<string, unknown>;

  if (body.context_management !== undefined || !Array.isArray(body.tools) || !body.tools.length)
    return;

  return {
    ...body,
    context_management: {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: {
            type: "input_tokens",
            value: Math.max(20000, Math.floor(model!.contextWindow * 0.65)),
          },
          keep: { type: "tool_uses", value: 6 },
          clear_at_least: { type: "input_tokens", value: 8000 },
          exclude_tools: ["history", "notes", "new_context"],
        },
      ],
    },
  };
}
