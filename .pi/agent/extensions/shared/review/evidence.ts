import { createHash, randomUUID } from "node:crypto";
import { type ReviewSettings } from "./protocol.ts";
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

import { recordedTaskIndex, selectedOperatorPrompts } from "./prompts.ts";

export { operatorPrompts } from "./prompts.ts";

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
  const selectedPrompts = selectedOperatorPrompts(entries, config.recentUserPrompts);
  const originals = selectedPrompts.map((prompt) => prompt.text);

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
  const userPromptInfo = originals.map((original, index) => {
    const inputKind = selectedPrompts[index]?.kind ?? "operator-command";

    return {
      promptId: createHash("sha256").update(original).digest("hex"),
      inputKind,
      isSteering: inputKind === "unknown" ? null : inputKind === "steering",
      compressed: prepared?.records[index].compressed ?? false,
      originalBytes: Buffer.byteLength(original),
      compressionVersion: prepared?.records[index].version,
      cacheHit: prepared?.records[index].cacheHit ?? false,
    };
  });

  const promptSources = new Map(
    prepared?.records
      .filter((record) => record.compressed)
      .map((record) => [record.promptId, record.original]),
  );
  const latest = selectedPrompts.at(-1);
  const taskIndex = recordedTaskIndex(selectedPrompts);
  const taskContext = {
    latestInputKind: latest?.kind ?? "operator-command",
    source: operatorGoal
      ? "operator-goal"
      : taskIndex >= 0
        ? "recorded-task-input"
        : "unclassified-history",
    ...(!operatorGoal && taskIndex >= 0
      ? {
          taskPromptIndex: taskIndex,
          taskPromptId: userPromptInfo[taskIndex].promptId,
        }
      : {}),
  };
  const reviewedEvidence = reviewedReceipts(entries);
  const core = {
    userPrompts,
    userPromptInfo,
    latestUserPrompt: userPrompts.at(-1),
    latestUserLanguageReference: reviewLanguageReference(originals.at(-1)!),
    operatorGoal,
    taskContext,
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
