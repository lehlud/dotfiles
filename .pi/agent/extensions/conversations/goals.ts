import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalTool } from "./goal-tool.ts";
import { GoalController } from "./goal-controller.ts";
import { registerGoalContext } from "../shared/session/goal-context.ts";

export function registerGoals(pi: ExtensionAPI) {
  const controller = new GoalController(pi);

  registerGoalTool(pi);
  registerGoalContext(pi);

  pi.on("session_start", (event, ctx) => controller.restore(event, ctx));
  pi.on("session_tree", (event, ctx) => controller.restore(event, ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    controller.shutdown(ctx);
  });

  pi.on("turn_end", (event, ctx) => controller.check(event, ctx));

  pi.registerCommand("goal", {
    description:
      "Run until independent goal verification: /goal <target>, status, resume, stop; drop removes the goal without interrupting work",
    handler: (args, ctx) => controller.command(args, ctx),
  });

  return () =>
    controller.goal?.status === "running" && controller.goal.source !== "agent"
      ? controller.goal.text
      : undefined;
}
