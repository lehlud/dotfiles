import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const USAGE_POLICY_TYPE = "subagent-usage-instruction";
export const USAGE_POLICY = `Work alone by default. Spawn or resurrect subagents only when the operator explicitly requests subagents, additional parallel agents, or an independent second opinion. A normal review, task complexity, generic continuation or Multiplex membership does not request more agents. Do the initial scoping yourself before delegating. Before an allowed spawn, state the specific independent question and expected benefit. Start one agent and reuse it; multiple agents require an explicit request for multiple agents. Do routine exploration, implementation, tests and self-review yourself. If unsure, continue alone without asking for delegation permission.`;

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
