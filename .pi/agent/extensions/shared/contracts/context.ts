import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTEXT_TOOLS = ["history", "notes", "new_context"] as const;

/** These tools inspect only the owning session; they do not execute external actions. */
export function availableContextTools(pi: ExtensionAPI): string[] {
  const registered = new Set(pi.getAllTools?.().map((tool) => tool.name));

  return CONTEXT_TOOLS.filter((name) => registered.has(name));
}
