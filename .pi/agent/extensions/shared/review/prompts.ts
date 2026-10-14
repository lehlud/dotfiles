import { createHash } from "node:crypto";
import { OPERATOR_INPUT_ENTRY, type OperatorInputKind } from "../contracts/operator-input.ts";
import type { Entry } from "./entries.ts";
import { textContent } from "./protocol.ts";

export const promptDigest = (text: string) => createHash("sha256").update(text).digest("hex");

export type OperatorPrompt = {
  text: string;
  entryId?: string;
  kind: OperatorInputKind | "operator-command" | "unknown";
  taskEntryId?: string;
};

/** Only genuine user messages and the existing operator-command capture establish intent. */
export function operatorPromptRecords(entries: readonly Entry[]): OperatorPrompt[] {
  const metadata = new Map<
    string,
    { promptId: string; kind: OperatorInputKind; taskEntryId?: string }
  >();

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== OPERATOR_INPUT_ENTRY) {
      continue;
    }

    const data = entry.data as Record<string, unknown> | undefined;

    if (
      !data ||
      typeof data.messageId !== "string" ||
      typeof data.promptId !== "string" ||
      (data.kind !== "task" && data.kind !== "steering")
    ) {
      continue;
    }

    metadata.set(data.messageId, {
      promptId: data.promptId,
      kind: data.kind,
      taskEntryId: typeof data.taskEntryId === "string" ? data.taskEntryId : undefined,
    });
  }

  const capturedGoals = new Set(
    entries
      .filter(
        (entry) => entry.type === "custom" && entry.customType === "auto-approval-operator-prompt",
      )
      .map((entry) => (entry.data as { goalId?: string })?.goalId),
  );
  const prompts: OperatorPrompt[] = [];

  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "user") {
      const text =
        textContent(entry.message.content) || "[Non-text user prompt; intent unavailable]";
      const recorded = entry.id ? metadata.get(entry.id) : undefined;
      const matched = recorded && recorded.promptId === promptDigest(text) ? recorded : undefined;

      prompts.push({
        text,
        entryId: entry.id,
        kind: matched?.kind ?? "unknown",
        taskEntryId: matched?.taskEntryId,
      });
    } else if (entry.type === "custom" && entry.customType === "auto-approval-operator-prompt") {
      const text = (entry.data as { text?: unknown })?.text;

      if (typeof text === "string" && text.trim()) {
        prompts.push({ text, kind: "operator-command" });
      }

    } else if (entry.type === "custom" && entry.customType === "auto-approval-goal") {
      const goal = entry.data as {
        id?: string;
        text?: string;
        status?: string;
        checks?: number;
        reason?: string;
      };

      if (
        typeof goal?.id === "string" &&
        typeof goal.text === "string" &&
        goal.text.trim() &&
        !capturedGoals.has(goal.id) &&
        goal.status === "running" &&
        goal.checks === 0 &&
        goal.reason === "Goal not yet verified"
      ) {
        capturedGoals.add(goal.id);
        prompts.push({ text: goal.text, kind: "operator-command" });
      }

    }

  }

  return prompts;
}

/** Preserve the recent window and the recorded task frame, including every later correction. */
export function selectedOperatorPrompts(
  entries: readonly Entry[],
  limit: number,
): OperatorPrompt[] {
  const prompts = operatorPromptRecords(entries);
  const selected = prompts.slice(-limit);
  const latest = selected.at(-1);

  if (latest?.kind !== "steering") {
    return selected;
  }

  let start = latest.taskEntryId
    ? prompts.findIndex((prompt) => prompt.entryId === latest.taskEntryId && prompt.kind === "task")
    : -1;

  if (start < 0) {
    start = prompts.length - 1;

    while (start > 0 && prompts[start - 1].kind === "steering") {
      start--;
    }

  }

  const retained = new Set([...selected, ...prompts.slice(start)]);

  return prompts.filter((prompt) => retained.has(prompt));
}

export function operatorPrompts(entries: readonly Entry[], limit: number): string[] {
  return selectedOperatorPrompts(entries, limit).map((prompt) => prompt.text);
}

