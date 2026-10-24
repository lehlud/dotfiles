import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GOAL_TOOL } from "../shared/contracts/goal.ts";
import { sessionServices } from "../shared/session/services.ts";

/** The controller independently approves each proposal before changing goal metadata. */
export function registerGoalTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: GOAL_TOOL,
    label: "Set session goal",
    exposure: "model-only",
    executionMode: "parallel",
    description:
      "Request independent approval for a goal faithful to the full user task, without weakening outcomes or validation. Every call is reviewed, including repeats/resumes. Cannot replace an active goal or reset review feedback. Approval grants no external-action permission; completion is separately verified.",
    parameters: Type.Object(
      { goal: Type.String({ minLength: 1, maxLength: 8000 }) },
      {
        additionalProperties: false,
      },
    ),
    async execute(_id, args, signal, update, ctx) {
      const set = sessionServices(ctx).setAgentGoal;

      if (!set) {
        throw new Error("Session goal controller unavailable");
      }

      const goal = await set(args.goal, signal, (text) =>
        update?.({
          content: [{ type: "text", text }],
          details: { phase: "reviewing" },
        }),
      );

      return {
        content: [{ type: "text", text: `Agent goal: ${goal.text} · ${goal.status}` }],
        details: { goal },
      };
    },
  });
}
