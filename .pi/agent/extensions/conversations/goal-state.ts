import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Goal } from "../shared/contracts/goal.ts";

export type { Goal } from "../shared/contracts/goal.ts";

export type GoalReview = {
  goalId?: string;
  superseded?: boolean;
  verdict?: { decision?: string; reason?: string; blocked?: boolean };
};

export const STATE_ENTRY = "auto-approval-goal";
export const INSTRUCTION_TYPE = "auto-approval-goal-instruction";
// Pi sorts footer statuses by key: team size, target, then transient review.
export const STATUS_KEY = "01-goal";

export function goalTitle(text: string) {
  const plain = stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return stripTerminalSequences(truncateToWidth(plain, 100, "…"));
}

export const message = (text: string) => ({
  customType: INSTRUCTION_TYPE,
  content: text,
  display: false,
});
export const instruction = (current: Goal) =>
  `${current.source === "agent" ? "Agent goal (self-assigned, not operator authorization)" : "Operator goal"}: ${current.text}\nContinue this existing task from the saved conversation until the independent goal reviewer confirms completion. Provide concrete evidence and required validation. All operations require approved_action under current operator authorization; prior denials do not create user prohibitions or permit execution without fresh approval. If the session was replaced or reloaded, recheck required temporary artifacts before reuse.${current.feedback ? `\nMissing work identified by the goal reviewer: ${current.feedback}` : ""}`;

/** Restore the latest checkpoint and independent feedback without resuming work. */
export function restoreGoal(branch: readonly SessionEntry[]): Goal | undefined {
  const last = branch.findLast((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY);
  const saved = last?.type === "custom" ? (last.data as Goal | undefined) : undefined;

  const goal: Goal | undefined =
    saved &&
    typeof saved.text === "string" &&
    typeof saved.id === "string" &&
    Number.isInteger(saved.checks) &&
    (saved.source === undefined || saved.source === "operator" || saved.source === "agent") &&
    ["running", "paused", "stopped"].includes(saved.status)
      ? { ...saved }
      : undefined;

  // Older checkpoints mixed UI pause reasons into the model's missing-work
  // instruction. Recover real feedback from the goal's independent audit.
  if (goal) {
    const id = goal.id;
    const audits = branch.flatMap((entry) =>
      entry.type === "custom" &&
      entry.customType === "auto-approval-goal-review" &&
      (entry.data as GoalReview)?.goalId === id
        ? [entry.data as GoalReview]
        : [],
    );
    const audit = audits.filter((entry) => !entry.superseded).at(-1);

    if (audit)
      goal.feedback =
        audit.verdict?.decision === "deny" && typeof audit.verdict.reason === "string"
          ? audit.verdict.reason
          : undefined;
    else if (typeof goal.feedback !== "string") goal.feedback = undefined;
  }

  return goal;
}
