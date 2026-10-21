import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionServices } from "./services.ts";

/** Replace runtime goal controls, including inherited copies, without editing history. */
export function registerGoalContext(pi: ExtensionAPI) {
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter(
      (entry) =>
        entry.role !== "custom" ||
        !["auto-approval-goal-instruction", "multiplex-operator-goal"].includes(entry.customType),
    );
    const instruction = sessionServices(ctx).goalInstruction?.();

    if (!instruction) return messages.length === event.messages.length ? undefined : { messages };

    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: "auto-approval-goal-instruction",
          content: instruction,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
}
