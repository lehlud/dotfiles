import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { parseVerdict, textContent, type ReviewSettings, type Reviewer } from "./protocol.ts";
import { reviewCapacityIssue } from "./context.ts";
import { promptOriginalTool } from "./originals.ts";
import { ReviewerToolError } from "./original-turn.ts";
import {
  providerAvailability,
  isRecoveryAuditError,
  RecoveryAuditError,
  providerRefusal,
  transientProviderError,
} from "../providers/availability.ts";

import type {
  ReviewEnvelope,
  ReviewRegistry,
  ReviewProcessing,
  ReviewAttempt,
  ReviewObserver,
  Usage,
} from "./contracts.ts";
import { ReviewExchange, originalLookupBudget } from "./transport.ts";

export type {
  ReviewRegistry,
  ReviewProcessing,
  ReviewAttempt,
  ReviewObserver,
} from "./contracts.ts";
export type { PromptLookup } from "./originals.ts";

export const reviewerLabel = (candidate: Reviewer) =>
  `${candidate.provider}/${candidate.model} (${candidate.thinking})`;

function providerFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";

  // Fixed labels only: provider errors can contain credentials or prompt text.
  if (transientProviderError(error)) return ": provider temporarily unavailable";

  if (/429|rate.?limit|quota/i.test(message)) return ": rate limit or quota unavailable";

  if (/401|403|unauthoriz|authentication|api.?key/i.test(message))
    return ": provider authentication rejected; use /login for this provider";

  if (/invalid.*schema|schema.*invalid|unsupported.*param|param.*not supported/i.test(message))
    return ": request schema or parameters rejected";

  if (/model.*not found|model.*does not exist|model.*not.*access/i.test(message))
    return ": reviewer model unavailable";

  if (/fetch failed|ECONN|ENOTFOUND|network|connection|socket/i.test(message))
    return ": provider connection unavailable";

  return "";
}

function incompleteReview(response: AssistantMessage, envelope: ReviewEnvelope) {
  if (response.errorMessage === new RecoveryAuditError().message)
    return { blocked: response.errorMessage };

  try {
    const verdict = parseVerdict(
      textContent(response.content),
      envelope.requestId,
      envelope.goalCheck,
    );

    if (verdict.decision === "deny") return { denial: verdict };
  } catch {
    /* An incomplete response need not contain a complete verdict. */
  }

  const refused =
    /refusal/i.test(response.rawStopReason ?? "") ||
    providerRefusal(`${response.rawStopReason ?? ""} ${response.errorMessage ?? ""}`);

  if (refused) return { blocked: "Reviewer refused the check; no fallback, nothing executed" };

  if (response.stopReason !== "error")
    return {
      blocked: `Reviewer response is incomplete (${response.stopReason}); no fallback, nothing executed`,
    };

  return {
    failure: `Reviewer provider response failed (error)${providerFailureDetail(response.errorMessage)}`,
  };
}

export class ReviewError extends Error {
  constructor(
    message: string,
    public attempts: ReviewAttempt[],
    public usage?: Usage,
  ) {
    super(message);
  }
}

function unavailable(
  registry: ReviewRegistry,
  candidate: Reviewer,
  model: ReturnType<ReviewRegistry["find"]>,
) {
  if (!model) return "Reviewer model not found";

  if (!registry.hasConfiguredAuth(model))
    return `Reviewer authentication is unavailable. Use /login and select ${candidate.provider} on this machine; credentials are private and not synced with dotfiles.`;

  if (
    candidate.thinking !== "off" &&
    (!model.reasoning ||
      (model.thinkingLevelMap && model.thinkingLevelMap[candidate.thinking] === undefined))
  )
    return "Reviewer does not support the configured thinking level";
}

function reviewContext(envelope: ReviewEnvelope, systemPrompt: string): Context {
  const { latestUserPrompt } = JSON.parse(envelope.text);

  if (typeof latestUserPrompt !== "string" || !latestUserPrompt.trim())
    throw new Error("Latest operator prompt unavailable");

  return {
    systemPrompt:
      systemPrompt +
      (envelope.promptSources?.size
        ? `\nuserPrompts contains the selected operator texts or marked summaries; originals remain authoritative. Use ONLY prompt_original to inspect relevant ranges/conditions. Before approval, inspect every compressed original at least once; empty results do not count. Excerpts are expected: rereading entire logs/transcripts is not a prerequisite. If more evidence is needed, use head/tail/read/grep within this review before deciding. Compression or incomplete excerpts alone do not warrant denial; if applicable operator constraints remain unclear, identify the concrete unresolved condition. The supplied action, completion or editorial criteria still govern the verdict. Explicit user requirements to read a whole prompt still apply. No filesystem, shell, network or other tools. Maximum ${originalLookupBudget(envelope)} original lookups. Return verdict JSON after required lookups; valid denials remain final.`
        : ""),
    // Keep language metadata inside the complete envelope; a repeated final
    // prompt would emphasize the latest correction over the authorized task.
    messages: [{ role: "user", content: envelope.text, timestamp: Date.now() }],
    ...(envelope.promptSources?.size ? { tools: [promptOriginalTool] } : {}),
  };
}

export async function requestVerdict(
  config: ReviewSettings,
  registry: ReviewRegistry,
  envelope: ReviewEnvelope,
  observer: ReviewObserver,
  signal: AbortSignal | undefined,
  systemPrompt: string,
  availability = providerAvailability,
  processing: ReviewProcessing = {},
) {
  const source = JSON.parse(envelope.text).latestUserPrompt;

  if (typeof source !== "string" || !source.trim())
    throw new ReviewError("Latest operator prompt unavailable; no fallback, nothing executed", []);

  const context = reviewContext(envelope, systemPrompt);
  const attempts: ReviewAttempt[] = [];

  const candidate = config.reviewer;

  if (!candidate) throw new ReviewError("No reviewer selected; use /reviewer to choose one", []);

  const exchange = new ReviewExchange({
    registry,
    candidate,
    envelope,
    context,
    timeoutMs: config.requestTimeoutMs,
    signal,
    observer,
    availability,
    processing,
  });

  signal?.throwIfAborted();
  observer.start(candidate);

  const model = registry.find(candidate.provider, candidate.model);
  let reason = unavailable(registry, candidate, model);

  if (!reason && model) reason = reviewCapacityIssue(context, model);

  let response: AssistantMessage | undefined;

  try {
    if (!reason && model) {
      response = await exchange.run(model);
    }
  } catch (error) {
    signal?.throwIfAborted();

    if (isRecoveryAuditError(error) || error instanceof ReviewerToolError) {
      const detail = isRecoveryAuditError(error) ? "Provider recovery audit failed" : error.message;
      const reason = `${detail}; no fallback, nothing executed`;

      attempts.push({ ...candidate, status: "invalid", reason });

      throw new ReviewError(reason, attempts, exchange.usage);
    }

    if (error instanceof Error && providerRefusal(error.message)) {
      const reason = "Reviewer refused the check; no fallback, nothing executed";

      attempts.push({ ...candidate, status: "invalid", reason });

      throw new ReviewError(reason, attempts, exchange.usage);
    }

    reason =
      error instanceof Error && error.message === "Reviewer request timed out"
        ? error.message
        : `Reviewer provider request failed${providerFailureDetail(error)}`;
  } finally {
    observer.finish();
  }

  signal?.throwIfAborted();

  if (response) {
    if (response.stopReason !== "stop") {
      // An explicit request-bound denial stays final even if transport fails
      // after delivering it. An approval from a failed response is never used.
      const stopped = incompleteReview(response, envelope);

      if (stopped.denial) {
        attempts.push({ ...candidate, status: "deny", reason: stopped.denial.reason });

        return {
          verdict: stopped.denial,
          selectedReviewer: candidate,
          attempts,
          usage: exchange.usage,
          promptLookups: exchange.promptLookups,
        };
      }

      if (stopped.blocked) {
        attempts.push({ ...candidate, status: "invalid", reason: stopped.blocked });

        throw new ReviewError(stopped.blocked, attempts, exchange.usage);
      }

      reason = stopped.failure;
    }
  }

  if (reason) {
    const attempt: ReviewAttempt = { ...candidate, status: "failed", reason };

    attempts.push(attempt);
    // A failed audit/display callback aborts review, never authorizes execution.
    observer.failed(attempt);

    throw new ReviewError(
      `Reviewer check failed: ${reviewerLabel(candidate)}: ${reason}`,
      attempts,
      exchange.usage,
    );
  }

  let verdict: ReturnType<typeof parseVerdict>;

  try {
    verdict = parseVerdict(textContent(response!.content), envelope.requestId, envelope.goalCheck);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invalid reviewer verdict";

    attempts.push({ ...candidate, status: "invalid", reason });

    throw new ReviewError(reason, attempts, exchange.usage);
  }

  if (
    verdict.decision === "approve" &&
    [...(envelope.promptSources?.keys() ?? [])].some((id) => !exchange.consulted.has(id))
  ) {
    const reason =
      "Reviewer must inspect every compressed original before approval; no fallback, nothing executed";

    attempts.push({ ...candidate, status: "invalid", reason });

    throw new ReviewError(reason, attempts, exchange.usage);
  }

  attempts.push({ ...candidate, status: verdict.decision, reason: verdict.reason });

  // A valid denial is final. Never search for a model willing to approve it.
  return {
    verdict,
    selectedReviewer: candidate,
    attempts,
    usage: exchange.usage,
    promptLookups: exchange.promptLookups,
  };
}
