import type { ActionAudit, Entry, ReviewedEvidence } from "./entries.ts";
import { operatorPromptRecords } from "./prompts.ts";

/** Only verdict audits are review evidence; a local coordination failure grants or denies no action. */
export function previousDenials(entries: readonly Entry[]) {
  // Local coordination failures are preflight results, not action-review verdicts.
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === "custom" && entry.customType === "auto-approval-review")
    .map(({ entry, index }) => ({ audit: entry.data as ActionAudit, index }))
    .filter(
      ({ audit }) =>
        audit?.decision === "deny" &&
        !(audit.technicalFailure === true && audit.technicalStage === "team coordination"),
    )
    .slice(-6)
    .map(({ audit: d, index }) => ({
      decision: d.decision,
      reason: d.reason,
      requestId: d.requestId,
      fingerprint: d.fingerprint,
      tool: d.action?.tool,
      technicalFailure: d.technicalFailure,
      technicalStage: d.technicalStage,
      laterOperatorPromptCount: operatorPromptRecords(entries.slice(index + 1)).length,
      ...(d.action ? { actionOmitted: true } : {}),
    }));
}

function isTextBlock(item: unknown): boolean {
  return typeof item === "object" && item !== null && "type" in item && item.type === "text";
}

/** Match each result against an earlier approved receipt, including its runtime-bound peer identity. */
export function reviewedReceipts(entries: readonly Entry[]): ReviewedEvidence[] {
  const approvals = new Map<string, ActionAudit>();
  const reviewedEvidence: ReviewedEvidence[] = [];

  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "auto-approval-review") {
      const audit = entry.data as ActionAudit;

      if (
        audit?.decision === "approve" &&
        [
          "read",
          "bash",
          "powershell",
          "grep",
          "find",
          "ls",
          "edit",
          "write",
          "websearch",
          "webfetch",
          "writing_check",
          "credential_exec",
          "git",
        ].includes(audit.action?.tool ?? "") &&
        audit.toolCallId
      )
        approvals.set(JSON.stringify([audit.multiplexAgent ?? "", audit.toolCallId]), audit);
    }

    // Peer evidence comes only from the extension broker; ordinary mailbox
    // text cannot create these trusted entries.
    const peer =
      entry.type === "custom" && entry.customType === "auto-approval-peer-result"
        ? (entry.data as { multiplexAgent?: string; message?: Entry["message"] })
        : undefined;
    const message = peer?.message ?? entry.message;

    if (
      (!peer && entry.type !== "message") ||
      message?.role !== "toolResult" ||
      message.toolName !== "approved_action" ||
      message.isError
    )
      continue;

    const details = message.details as { approval?: ActionAudit; result?: unknown } | undefined;
    const receipt = details?.approval;

    if (peer && peer.multiplexAgent !== receipt?.multiplexAgent) continue;

    const audit = approvals.get(
      JSON.stringify([
        peer?.multiplexAgent ?? receipt?.multiplexAgent ?? "",
        message.toolCallId ?? "",
      ]),
    );

    if (
      !audit?.requestId ||
      !audit.action ||
      !audit.fingerprint ||
      receipt?.decision !== "approve" ||
      receipt.requestId !== audit.requestId ||
      receipt.fingerprint !== audit.fingerprint
    )
      continue;

    const pageOnly = ["websearch", "webfetch"].includes(audit.action.tool);
    const content = Array.isArray(message.content)
      ? message.content.slice(pageOnly ? 0 : 1).filter(isTextBlock)
      : [];

    if (!content.length) continue;

    reviewedEvidence.push({
      tool: audit.action.tool,
      arguments: audit.action.arguments,
      path: audit.action.arguments.path,
      cwd: audit.cwd,
      requestId: audit.requestId,
      content,
      details: details?.result,
    });
  }

  return reviewedEvidence;
}
