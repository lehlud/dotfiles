import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ActionAudit, Entry, ReviewedEvidence } from "./entries.ts";
import { operatorPromptRecords, promptDigest } from "./prompts.ts";

function operationIdentity(action: unknown, cwd: unknown) {
  if (!action || typeof action !== "object" || !("tool" in action)) return undefined;

  const value = action as Record<string, unknown>;

  return {
    cwd,
    tool: value.tool,
    arguments: value.arguments,
    sandbox: value.sandbox,
    network: value.network,
  };
}

/** Compare locally; historical command bodies and access requests stay out of the envelope. */
function denialEvidence(audit: ActionAudit, later: readonly Entry[], current: unknown) {
  const operation = operationIdentity(audit.action, audit.cwd);
  const prompts = operatorPromptRecords(later);

  return {
    source: "historical-review-result",
    decision: audit.decision,
    reason: audit.reason,
    requestId: audit.requestId,
    fingerprint: audit.fingerprint,
    tool: audit.action?.tool,
    technicalFailure: audit.technicalFailure,
    technicalStage: audit.technicalStage,
    laterOperatorPromptCount: prompts.length,
    laterOperatorPromptIds: prompts.slice(-10).map((prompt) => promptDigest(prompt.text)),
    ...(operation
      ? {
          actionOmitted: true,
          operationDigest: createHash("sha256").update(JSON.stringify(operation)).digest("hex"),
          ...(current ? { matchesCurrentOperation: isDeepStrictEqual(operation, current) } : {}),
        }
      : {}),
  };
}

/** Only verdict audits are review evidence; a local coordination failure grants or denies no action. */
export function previousDenials(entries: readonly Entry[], action?: unknown, cwd?: string) {
  const current = operationIdentity(action, cwd);

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
    .map(({ audit, index }) => denialEvidence(audit, entries.slice(index + 1), current));
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
          "remote_tunnel",
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
