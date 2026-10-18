import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GOAL_TOOL } from "../shared/contracts/goal.ts";
import { sessionServices } from "../shared/session/services.ts";

/** Session metadata only: goals never confer user authorization or execute actions. */
export function registerGoalTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: GOAL_TOOL,
    label: "Set session goal",
    exposure: "model-only",
    executionMode: "parallel",
    description:
      "Set a self-assigned session goal within the user's task. Cannot replace an active goal; repeating your own goal resumes it without resetting review feedback. Completion is independently verified. Grants no action permission.",
    parameters: Type.Object(
      { goal: Type.String({ minLength: 1, maxLength: 8000 }) },
      {
        additionalProperties: false,
      },
    ),
    async execute(_id, args, signal, _update, ctx) {
      const set = sessionServices(ctx).setAgentGoal;

      if (!set) {
        throw new Error("Session goal controller unavailable");
      }

      const goal = await set(args.goal, signal);

      return {
        content: [{ type: "text", text: `Agent goal: ${goal.text} · ${goal.status}` }],
        details: { goal },
      };
    },
  });
}
