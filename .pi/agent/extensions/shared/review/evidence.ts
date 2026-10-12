import { createHash, randomUUID } from "node:crypto";
import { textContent, type ReviewSettings } from "./protocol.ts";
import {
  checkReviewSize,
  MAX_REVIEW_CONTEXT_BYTES,
  MAX_REVIEW_EVIDENCE_BYTES,
  reviewLanguageReference,
} from "./context.ts";
import type { PreparedPrompts } from "./contracts.ts";

import type { Entry } from "./entries.ts";

export type { Entry } from "./entries.ts";

import { previousDenials, reviewedReceipts } from "./receipts.ts";

export function operatorPrompts(entries: readonly Entry[], limit: number): string[] {
  // Only raw user messages and operator prompts captured by our command handler.
  // Assistant summaries, arbitrary custom messages and tool output are excluded.
  const capturedGoals = new Set(
    entries
      .filter((e) => e.type === "custom" && e.customType === "auto-approval-operator-prompt")
      .map((e) => (e.data as { goalId?: string })?.goalId),
  );

  return entries
    .flatMap((e) => {
      if (e.type === "message" && e.message?.role === "user")
        return [textContent(e.message.content) || "[Non-text user prompt; intent unavailable]"];

      if (e.type === "custom" && e.customType === "auto-approval-operator-prompt") {
        const prompt = (e.data as { text?: unknown })?.text;

        if (typeof prompt === "string" && prompt.trim()) return [prompt];

      }

      // Sessions from before explicit prompt capture stored the original command
      // only in its initial goal snapshot. Keep its position in user chronology.
      if (e.type === "custom" && e.customType === "auto-approval-goal") {
        const goal = e.data as {
          id?: string;
          text?: string;
          checks?: number;
          reason?: string;
          status?: string;
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

          return [goal.text];
        }

      }

      return [];
    })

    .slice(-limit);
}

export function buildEvidence(
  entries: readonly Entry[],
  config: ReviewSettings,
  cwd: string,
  options: {
    operatorGoal?: string;
    prepared?: PreparedPrompts;
    action?: unknown;
    protectedPaths?: string[];
    sandboxPlan?: unknown;
  } = {},
) {
  const { operatorGoal, prepared, action, protectedPaths, sandboxPlan } = options;
  const originals = operatorPrompts(entries, config.recentUserPrompts);

  if (!originals.length && operatorGoal) originals.push(operatorGoal);

  if (!originals.length)
    throw new Error("No actual user prompts available; cannot establish user intent");

  if (
    prepared &&
    (prepared.records.length !== originals.length ||
      prepared.records.some((record, index) => record.original !== originals[index]))
  )
    throw new Error("Prepared prompt context does not match the actual operator branch");

  const userPrompts = prepared ? prepared.records.map((record) => record.text) : originals;
  const userPromptInfo = originals.map((original, index) => ({
    promptId: createHash("sha256").update(original).digest("hex"),
    compressed: prepared?.records[index].compressed ?? false,
    originalBytes: Buffer.byteLength(original),
    compressionVersion: prepared?.records[index].version,
    cacheHit: prepared?.records[index].cacheHit ?? false,
  }));
  const promptSources = new Map(
    prepared?.records
      .filter((record) => record.compressed)
      .map((record) => [record.promptId, record.original]),
  );
  const reviewedEvidence = reviewedReceipts(entries);
  const core = {
    userPrompts,
    userPromptInfo,
    latestUserPrompt: userPrompts.at(-1),
    latestUserLanguageReference: reviewLanguageReference(originals.at(-1)!),
    operatorGoal,
    previousDenials: previousDenials(entries),
    cwd,
    protectedPaths,
    action,
    sandboxPlan,
  };
  const selectedEvidence: typeof reviewedEvidence = [];
  const omittedReads: unknown[] = [];
  let evidenceBytes = 0;

  for (const item of reviewedEvidence.slice(-8).reverse()) {
    const candidate = [...selectedEvidence, item];
    const size = Buffer.byteLength(JSON.stringify(item));

    if (
      evidenceBytes + size <= MAX_REVIEW_EVIDENCE_BYTES &&
      Buffer.byteLength(
        JSON.stringify({
          ...core,
          reviewedReads: candidate.filter((entry) => entry.tool === "read"),
          reviewedContext: candidate.filter((entry) => entry.tool !== "read"),
        }),
      ) <=
        MAX_REVIEW_CONTEXT_BYTES - 4096
    ) {
      selectedEvidence.unshift(item);
      evidenceBytes += size;
    } else
      omittedReads.push({
        tool: item.tool,
        path: item.path,
        requestId: item.requestId,
        reason:
          "Tool evidence exceeds the context budget; inspect smaller relevant ranges only if needed for a concrete security concern",
      });

  }

  const requestId = randomUUID();
  const evidence = {
    ...core,
    reviewedReads: selectedEvidence.filter((item) => item.tool === "read"),
    reviewedContext: selectedEvidence.filter((item) => item.tool !== "read"),
    omittedReadEvidence: omittedReads,
  };

  return {
    requestId,
    fingerprint: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    text: checkReviewSize({ requestId, ...evidence }),
    promptSources,
    compressionUsage: prepared?.usage,
  };
}

