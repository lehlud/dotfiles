import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_TOOL = "set_goal";

export type GoalSource = "operator" | "agent";

export type Goal = {
  id: string;
  text: string;
  // Missing only in legacy operator-created checkpoints.
  source?: GoalSource;
  status: "running" | "paused" | "complete" | "stopped";
  checks: number;
  reason: string;
  feedback?: string;
};

/** Only advertise the local goal tool when its owning extension is loaded. */
export function availableGoalTools(pi: ExtensionAPI): string[] {
  return pi.getAllTools?.().some((tool) => tool.name === GOAL_TOOL) ? [GOAL_TOOL] : [];
}
