import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const USAGE_POLICY_TYPE = "subagent-usage-instruction";
export const USAGE_POLICY = `Work alone by default. Handle routine exploration, implementation, tests and self-review yourself. Spawn/resurrect only when the operator explicitly requests subagents, additional parallel agents or an independent second opinion; ordinary review, complexity, continuation and Multiplex membership do not qualify. Scope the task yourself; before spawning, state the independent question and benefit. Start one and reuse it; multiple agents require an explicit multiple-agent request. If unsure, continue alone without asking for delegation permission.`;

/** Keep delegation restraint visible on every main/member request, outside saved history. */
export function registerUsagePolicy(pi: ExtensionAPI) {
  pi.on("context", (event) => ({
    messages: [
      ...event.messages.filter(
        (entry) => entry.role !== "custom" || entry.customType !== USAGE_POLICY_TYPE,
      ),
      {
        role: "custom",
        customType: USAGE_POLICY_TYPE,
        content: USAGE_POLICY,
        display: false,
        timestamp: Date.now(),
      },
    ],
  }));
}
