import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalController } from "./goal-controller.ts";
import { INSTRUCTION_TYPE, instruction, message } from "./goal-state.ts";

export function registerGoals(pi: ExtensionAPI) {
  const controller = new GoalController(pi);
  pi.on("session_start", (event, ctx) => controller.restore(event, ctx));
  pi.on("session_tree", (event, ctx) => controller.restore(event, ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    controller.shutdown(ctx);
  });
  pi.on("turn_end", (event, ctx) => controller.check(event, ctx));
  pi.on("context", (event) => {
    if (controller.goal?.status !== "running") return;
    // Replace obsolete control hints only in the request, never in the saved
    // transcript. One current instruction also avoids repeating the target.
    const messages = event.messages.filter(
      (entry) => entry.role !== "custom" || entry.customType !== INSTRUCTION_TYPE,
    );
    return {
      messages: [
        ...messages,
        { role: "custom", ...message(instruction(controller.goal)), timestamp: Date.now() },
      ],
    };
  });
  pi.registerCommand("goal", {
    description: "Run until independent goal verification: /goal <target>, status, resume, stop",
    handler: (args, ctx) => controller.command(args, ctx),
  });
  return () => (controller.goal?.status === "running" ? controller.goal.text : undefined);
}
