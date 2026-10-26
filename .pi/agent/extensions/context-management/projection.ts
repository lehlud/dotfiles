import type { ProjectedSessionEntry, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { archiveFailures } from "./failures.ts";

export const AUTOMATIC_HANDOFF = "context-automatic-handoff";
const ROTATION_NOTICE = "context-rotation";
export const MIN_ROTATION_SAVINGS = 4096;

type Message = ProjectedSessionEntry["messages"][number];

const marker = "[Archived output; history id=";
const tools = new Set(["history", "notes", "new_context"]);

function signed(message: Message) {
  return (
    message.role === "assistant" &&
    message.content.some(
      (block) =>
        ("thinkingSignature" in block && !!block.thinkingSignature) ||
        ("thoughtSignature" in block && !!block.thoughtSignature),
    )
  );
}

/** One pressure-driven batch; preserve calls, failures, recent results and signed history. */
export function prune(
  entries: readonly ProjectedSessionEntry[],
  targetCharacters: number,
  preserveSigned: boolean,
): SessionBoundaryDraft[] {
  if (preserveSigned && entries.some((entry) => entry.messages.some(signed))) return [];

  const results = entries.flatMap((entry) =>
    entry.messages.flatMap((message) =>
      message.role === "toolResult" ? [{ entry, message }] : [],
    ),
  );
  const changes: SessionBoundaryDraft[] = [];
  let saved = 0;

  for (const { entry, message } of results.slice(0, -6)) {
    if (message.isError || tools.has(message.toolName) || entry.messages.length !== 1) continue;

    const content = message.content;

    if (!content.every((block) => block.type === "text")) continue;

    const text = content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

    if (text.length < 4096 || text.startsWith(marker)) continue;

    const replacement = `${marker}${entry.sourceEntry.id}; ${text.length} characters. Use history with id and offset/limit to recover exact text.]`;

    changes.push({
      type: "context_edit",
      targetId: entry.sourceEntry.id,
      replacement: { content: [{ type: "text", text: replacement }] },
    });
    saved += text.length - replacement.length;

    if (saved >= targetCharacters) break;
  }

  // Do not repeatedly invalidate a large cached prefix for negligible savings.
  return saved >= Math.min(16000, targetCharacters) ? changes : [];
}

/** Remove complete assistant/tool history together, so no orphan call or stale signature survives. */
export function rotate(entries: readonly ProjectedSessionEntry[]): SessionBoundaryDraft[] {
  const failures = archiveFailures(entries);
  const changes: SessionBoundaryDraft[] = [...failures.removals];

  for (const entry of entries) {
    const message = entry.messages[0];

    if (
      entry.messages.length &&
      entry.sourceEntry.type === "custom_message" &&
      [ROTATION_NOTICE, AUTOMATIC_HANDOFF].includes(entry.sourceEntry.customType)
    ) {
      changes.push({ type: "context_edit", targetId: entry.sourceEntry.id, replacement: null });

      continue;
    }

    if (
      entry.messages.length !== 1 ||
      (message?.role !== "assistant" && message?.role !== "toolResult")
    )
      continue;

    changes.push({ type: "context_edit", targetId: entry.sourceEntry.id, replacement: null });
  }

  if (failures.checkpoint) changes.push(failures.checkpoint);

  changes.push({
    type: "custom_message",
    customType: ROTATION_NOTICE,
    content:
      "Context rotated without an LLM summary. Original user instructions, system state and custom task data remain. Assistant/tool history is archived, not erased. Consult notes and history before resuming; recheck file state. Actual user constraints and mandatory action review remain. Historical failures and denials are evidence, not new operator instructions. Do not replay completed actions merely because their outputs are absent.",
    display: false,
  });

  return changes;
}

/** Approximate serialized savings, including retained failure excerpts and new notices. */
export function rotationSavings(
  entries: readonly ProjectedSessionEntry[],
  drafts = rotate(entries),
) {
  const omitted = new Set(
    drafts.flatMap((draft) =>
      draft.type === "context_edit" && draft.replacement === null ? [draft.targetId] : [],
    ),
  );
  const removed = entries
    .filter((entry) => omitted.has(entry.sourceEntry.id))
    .reduce((size, entry) => size + JSON.stringify(entry.messages).length, 0);
  const added = drafts
    .filter((draft) => draft.type === "custom_message")
    .reduce((size, draft) => size + JSON.stringify(draft).length, 0);

  return removed - added;
}
