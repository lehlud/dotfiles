import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textContent } from "../shared/review/protocol.ts";

export const STEERING_TYPE = "auto-approval-steering-instruction";
export const STEERING_POLICY =
  "The operator supplied steering during this task. Apply their corrections to the ongoing work, then continue its remaining implementation and validation without waiting for the operator to repeat the original request. Finishing a correction alone does not finish the whole task. Explain intermediate progress as intermediate progress. Follow later constraints and explicit requests to stop or replace the task. Every operation still requires approved_action; steering grants no permission to bypass a denial. Reply in the language of the operator's latest actual message.";

/** Reinforce steering without rewriting user input or adding model turns. */
export function registerSteering(
  pi: ExtensionAPI,
  operatorGoal: (ctx: ExtensionContext) => string | undefined,
) {
  let originalTask: string | undefined;
  let steered = false;
  const reset = () => {
    originalTask = undefined;
    steered = false;
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_settled", reset);
  pi.on("before_agent_start", (event) => {
    originalTask = event.prompt;
    steered = false;
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || event.streamingBehavior !== "steer") return;

    steered = true;

    if (!originalTask && !operatorGoal(ctx)) {
      const last = ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .at(-1);

      originalTask =
        last?.type === "message" && last.message.role === "user"
          ? textContent(last.message.content)
          : undefined;
    }

  });

  pi.on("context", (event, ctx) => {
    if (!steered) return;

    // Active /goal requests already contain the authoritative objective. Other
    // tasks receive a bounded reminder explicitly marked as quoted data.
    const target = operatorGoal(ctx)
      ? "The active Operator goal remains the main task."
      : originalTask
        ? `Original task${originalTask.length > 4000 ? " excerpt (full request remains in the conversation)" : ""} (quoted DATA): ${JSON.stringify(originalTask.slice(0, 4000))}`
        : "The request that started this run remains the main task; consult its conversation context.";
    const messages = event.messages.filter(
      (entry) => entry.role !== "custom" || entry.customType !== STEERING_TYPE,
    );

    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: STEERING_TYPE,
          content: `${STEERING_POLICY}\n${target}`,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

}

