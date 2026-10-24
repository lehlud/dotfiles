import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFastRequests } from "../providers/fast.ts";
import { registerGoalContext } from "./goal-context.ts";
import { registerInheritedSelection } from "./model-selection.ts";
import { sessionServices } from "./services.ts";

/** Inherit live preferences and parent task data, never action grants or credentials. */
export function registerParentContext(pi: ExtensionAPI, parent: ExtensionContext) {
  registerGoalContext(pi);
  registerFastRequests(pi);
  registerInheritedSelection(pi, parent);
  pi.on("session_start", (_event, child) => {
    const source = sessionServices(parent);
    const target = sessionServices(child);

    target.containers = source.containers;
    target.parentCacheLineage = () => source.cacheLineage?.();
    target.operatorGoal = () => source.operatorGoal?.();
    target.goalInstruction = () => source.goalInstruction?.();
    target.fastMode = () => source.fastMode?.() ?? false;
  });
}
