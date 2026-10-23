import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ModelState } from "../configuration/model-state.ts";
import type { Reviewer } from "../review/protocol.ts";
import { registerInheritedRemote } from "./remote.ts";
import { sessionServices } from "./services.ts";

export function currentSelection(ctx: ExtensionContext): Reviewer | undefined {
  return ctx.model
    ? { provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel ?? "off" }
    : undefined;
}

/** Snapshot review choices at the same per-turn boundary as steering, never mid-review. */
export function registerReviewSelection(pi: ExtensionAPI, desired: () => Reviewer | undefined) {
  let active: Reviewer | undefined;
  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    active = structuredClone(desired());
    sessionServices(ctx).activeReviewer = () => structuredClone(active);
  };

  pi.on("session_start", refresh);
  pi.on("before_agent_start", refresh);
  pi.on("turn_start", refresh);
  pi.on("agent_end", refresh);

  return refresh;
}

/** Peers inherit preferences, not commands or permission to overwrite operator defaults. */
export function registerInheritedSelection(pi: ExtensionAPI, parent: ExtensionContext) {
  registerInheritedRemote(pi, parent);

  const desired = () => {
    const selected = sessionServices(parent).desiredReviewer;

    return selected ? selected() : new ModelState(getAgentDir()).reviewer();
  };

  registerReviewSelection(pi, desired);
  pi.on("session_start", (_event, child) => {
    sessionServices(child).desiredReviewer = desired;
    sessionServices(child).workingModel = () => sessionServices(parent).workingModel?.();
  });

  const refreshModel = async (_event: unknown, child: ExtensionContext) => {
    const selected = sessionServices(parent).workingModel?.();

    if (!selected) return;

    if (selected.provider !== child.model?.provider || selected.model !== child.model?.id) {
      const model = child.modelRegistry.find(selected.provider, selected.model);

      if (!model || !(await pi.setModel(model))) {
        throw new Error(
          `Selected working model unavailable: ${selected.provider}/${selected.model}`,
        );
      }
    }

    pi.setThinkingLevel(selected.thinking);
  };

  pi.on("before_agent_start", refreshModel);
  // AgentSession refreshes its next request's model after turn_end and tool completion.
  pi.on("turn_end", refreshModel);
}
