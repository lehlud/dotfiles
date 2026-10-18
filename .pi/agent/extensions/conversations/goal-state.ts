import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

import type { Goal } from "../shared/contracts/goal.ts";

export type { Goal } from "../shared/contracts/goal.ts";

export type GoalReview = {
  goalId?: string;
  superseded?: boolean;
  verdict?: { decision?: string; reason?: string };
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
  `${current.source === "agent" ? "Agent goal (self-assigned, not operator authorization)" : "Operator goal"}: ${current.text}\nContinue this existing task from the saved conversation until the independent goal reviewer confirms completion. Provide concrete evidence and required validation. All operations still require approved_action; respect denials and operator corrections. If the session was replaced or reloaded, recheck required temporary artifacts before reuse.${current.feedback ? `\nMissing work identified by the goal reviewer: ${current.feedback}` : ""}`;
