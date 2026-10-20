import { randomUUID } from "node:crypto";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { operatorPromptRecords, promptDigest } from "../shared/review/prompts.ts";
import { OPERATOR_INPUT_ENTRY } from "../shared/contracts/operator-input.ts";

/** Fork only complete tool batches; the parent's current spawn call is still pending. */
export function forkContext(ctx: ExtensionContext) {
  const branch = structuredClone(ctx.sessionManager.getBranch());
  const open = new Map<string, number>();

  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "message") continue;

    if (entry.message.role === "assistant") {
      for (const block of entry.message.content)
        if (block.type === "toolCall") open.set(block.id, index);
    } else if (entry.message.role === "toolResult") open.delete(entry.message.toolCallId);
  }

  const cutoff = open.size ? Math.min(...open.values()) : branch.length;
  const entries = branch.filter(
    (entry, index) => index < cutoff || entry.type !== "message" || entry.message.role === "user",
  );

  return SessionManager.inMemory(ctx.cwd, undefined, [
    {
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: ctx.cwd,
    },
    ...entries,
  ]);
}

/** Only the operator's actual newer messages are promoted to user input on resurrection. */
export function synchronizeOperator(ctx: ExtensionContext, manager: SessionManager) {
  const saved = manager.getEntries();
  const known = new Set(saved.map((entry) => entry.id));

  for (const entry of saved)
    if (entry.type === "custom" && entry.customType === "subagent-parent-input")
      known.add((entry.data as { id: string }).id);

  const prompts = operatorPromptRecords(ctx.sessionManager.getBranch());
  const seenTexts = new Map<string, number>();

  for (const entry of saved)
    if (entry.type === "message" && entry.message.role === "user") {
      const key = JSON.stringify(entry.message.content);

      seenTexts.set(key, (seenTexts.get(key) ?? 0) + 1);
    }

  const parentCounts = new Map<string, number>();
  const denials = new Set(
    saved.flatMap((entry) =>
      entry.type === "custom" && entry.customType === "auto-approval-review"
        ? [(entry.data as { requestId?: string })?.requestId]
        : [],
    ),
  );

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "user") {
      const key = JSON.stringify(entry.message.content),
        count = (parentCounts.get(key) ?? 0) + 1;

      parentCounts.set(key, count);

      if (known.has(entry.id) || (seenTexts.get(key) ?? 0) >= count) continue;

      const id = manager.appendMessage(structuredClone(entry.message));
      const prompt = prompts.find((item) => item.entryId === entry.id);

      if (prompt?.kind === "task" || prompt?.kind === "steering")
        manager.appendCustomEntry(OPERATOR_INPUT_ENTRY, {
          messageId: id,
          promptId: promptDigest(prompt.text),
          kind: prompt.kind,
        });

      manager.appendCustomEntry("subagent-parent-input", { id: entry.id });
    } else if (
      entry.type === "custom" &&
      entry.customType === "auto-approval-review" &&
      (entry.data as any)?.decision === "deny" &&
      !denials.has((entry.data as any)?.requestId)
    ) {
      manager.appendCustomEntry(entry.customType, structuredClone(entry.data));
      denials.add((entry.data as any)?.requestId);
    } else if (
      !known.has(entry.id) &&
      entry.type === "custom" &&
      entry.customType === "auto-approval-operator-prompt"
    ) {
      manager.appendCustomEntry(entry.customType, structuredClone(entry.data));
      manager.appendCustomEntry("subagent-parent-input", { id: entry.id });
    }
  }
}
