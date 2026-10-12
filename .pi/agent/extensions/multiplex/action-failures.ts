import type { ActivityEvent } from "./activity.ts";

/** Count malformed requests only; command failures and reviewer denials differ. */
export class ActionFailures {
  private counts = new Map<string, number>();
  observe(name: string, event: ActivityEvent): boolean {
    if (event.type !== "tool_execution_end" || event.toolName !== "approved_action") return false;

    const details = event.result?.details as any;
    const text =
      event.result?.content
        ?.filter((block: { type: string; text?: string }) => block.type === "text")
        .map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : ""))
        .join("\n") ?? "";
    const invalid =
      event.isError &&
      (text.startsWith('Validation failed for tool "approved_action"') ||
        (details?.technicalFailure === true && details?.technicalStage === "request validation"));
    const count = invalid ? (this.counts.get(name) ?? 0) + 1 : 0;

    this.counts.set(name, count);

    return count >= 3;
  }

}

