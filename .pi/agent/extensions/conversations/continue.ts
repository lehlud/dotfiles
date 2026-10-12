import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionServices } from "../shared/session/services.ts";

export const CONTINUE_TYPE = "conversation-continuation";
export const CONTINUE_INSTRUCTION =
  "The operator requests continuation of the existing task. Recover the task, latest corrections and remaining work from the conversation, then continue its implementation and validation. If it is already complete, report that; do not invent additional work. If a provider or other dependency remains unavailable, report the actual blocker. Preserve all existing constraints and action denials; this request grants no new access or permission to bypass approval. Use the language of the latest actual operator message.";

export function registerContinue(pi: ExtensionAPI) {
  let starting = false;

  pi.registerCommand("continue", {
    description: "Continue the current task, or resume a paused goal: /continue",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify(
          "Use /continue without arguments; send task changes as a normal message.",
          "warning",
        );

        return;
      }

      if (starting || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Work or queued input is already active. Wait or interrupt it first.",
          "warning",
        );

        return;
      }

      if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
        ctx.ui.notify("Working model unavailable; configure it first.", "error");

        return;
      }

      const services = sessionServices(ctx);

      starting = true;

      try {
        if (await services.resumeGoal?.(ctx)) return;

        if (
          !services.operatorGoal?.() &&
          !ctx.sessionManager
            .getBranch()
            .some((entry) => entry.type === "message" && entry.message.role === "user")
        ) {
          ctx.ui.notify("No task to continue. Send a task first.", "info");

          return;
        }

        services.continueTeam?.(CONTINUE_INSTRUCTION);
        services.resetProgress?.();
        pi.sendMessage(
          { customType: CONTINUE_TYPE, display: false, content: CONTINUE_INSTRUCTION },
          { triggerTurn: true },
        );
        ctx.ui.notify("Continuing the current task.", "info");
      } catch (error) {
        ctx.ui.notify(
          `Continue: ${error instanceof Error ? error.message : "Start failed"}`,
          "error",
        );
      } finally {
        starting = false;
      }

    },

  });
}

