import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
  constrainReviewPayload,
  parseVerdict,
  textContent,
  withWatchdog,
  type ReviewSettings,
  type Reviewer,
} from "./protocol.ts";
import type { ReviewEnvelope } from "./contracts.ts";
import { reviewCapacityIssue, REVIEW_OUTPUT_TOKENS } from "./context.ts";
import { promptOriginalTool, type PromptLookup } from "./originals.ts";
import { originalLookupTurn, ReviewerToolError, type LookupObserver } from "./original-turn.ts";
import { sumUsage } from "../providers/usage.ts";
import {
  ProviderAvailability,
  providerAvailability,
  isProviderHeldError,
  isRecoveryAuditError,
  RecoveryAuditError,
  providerRefusal,
  transientProviderError,
  type AvailabilityNotice,
} from "../providers/availability.ts";
import { installProviderStreams, unavailableResponse } from "../providers/stream.ts";
import { cacheReviewPayload, reviewCacheKey, reviewCacheRetention } from "./cache.ts";
import { fastPayload } from "../providers/fast.ts";

export type ReviewRegistry = Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "streamSimple">;

export type ReviewProcessing = { fastMode?: () => boolean };

type Usage = AssistantMessage["usage"];

export type { PromptLookup } from "./originals.ts";

export type ReviewAttempt = Reviewer & {
  status: "failed" | "invalid" | "approve" | "deny";
  reason: string;
};

export type ReviewObserver = LookupObserver & {
  start(candidate: Reviewer): void;
  finish(): void;
  failed(attempt: ReviewAttempt): void;
  retry?(event: AvailabilityNotice): void;
};

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

function originalLookupBudget(envelope: ReviewEnvelope): number {
  // Every compressed prompt must fit, with room for targeted follow-up reads.
  // The shared deadline and model-context checks bound the total work.
  return Math.max(8, (envelope.promptSources?.size ?? 0) + 4);
}

async function requestReview(
  registry: ReviewRegistry,
  candidate: Reviewer,
  model: NonNullable<ReturnType<ReviewRegistry["find"]>>,
  envelope: ReviewEnvelope,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  context: Context,
  state: ReviewState,
  availability: ProviderAvailability,
  observer: ReviewObserver,
) {
  const managed = installProviderStreams(registry as any, availability, observer.retry);

  return await withWatchdog(
    async (reviewSignal) => {
      const work = async () => {
        const fast = state.processing.fastMode?.() ?? false;
        const response = await registry
          .streamSimple(model, structuredClone(context), {
            reasoning: candidate.thinking === "off" ? undefined : candidate.thinking,
            signal: reviewSignal,
            maxTokens: REVIEW_OUTPUT_TOKENS,
            cacheRetention: reviewCacheRetention(model),
            sessionId: reviewCacheKey(envelope, context),
            onPayload: (payload, providerModel) => {
              const cached = cacheReviewPayload(
                constrainReviewPayload(payload, providerModel, envelope.goalCheck) ?? payload,
                providerModel,
                envelope,
              );

              return fastPayload(cached, providerModel, fast) ?? cached;
            },
          })
          .result();

        state.usage = sumUsage(state.usage, response.usage);

        return response;
      };

      return managed
        ? await work()
        : await availability.run(
            model,
            work,
            (response) => unavailableResponse(response, context),
            reviewSignal,
            observer.retry,
          );
    },

    timeoutMs,
    signal,
  );
}

type ReviewState = {
  usage?: Usage;
  promptLookups: PromptLookup[];
  consulted: Set<string>;
  processing: ReviewProcessing;
};

async function requestCandidate(
  registry: ReviewRegistry,
  candidate: Reviewer,
  model: NonNullable<ReturnType<ReviewRegistry["find"]>>,
  envelope: ReviewEnvelope,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  initial: Context,
  observer: ReviewObserver,
  state: ReviewState,
  availability: ProviderAvailability,
) {
  const context = structuredClone(initial);
  const started = Date.now();
  const lookupBudget = originalLookupBudget(envelope);
  const lookups = {
    attempts: 0,
    failures: 0,
    limit: lookupBudget,
    promptLookups: state.promptLookups,
    consulted: state.consulted,
  };

  for (let round = 0; round <= lookupBudget; round++) {
    const remaining = timeoutMs - (Date.now() - started);

    if (remaining <= 0) throw new Error("Reviewer request timed out");

    if (reviewCapacityIssue(context, model))
      throw new ReviewerToolError("Reviewer lookup context exceeds model capacity");

    const response = await requestReview(
      registry,
      candidate,
      model,
      envelope,
      remaining,
      signal,
      context,
      state,
      availability,
      observer,
    );
    const calls = response.content.filter((block) => block.type === "toolCall");

    if (!calls.length) return response;

    try {
      if (
        parseVerdict(textContent(response.content), envelope.requestId, envelope.goalCheck)
          .decision === "deny"
      )
        return response;
    } catch {
      /* A tool turn need not contain a verdict yet. */
    }

    const sources = envelope.promptSources;

    if (response.stopReason !== "toolUse" || !sources?.size)
      throw new ReviewerToolError("Invalid reviewer tool response");

    context.messages.push(response);

    for (const call of calls) {
      context.messages.push(originalLookupTurn(call, sources, lookups, observer));
    }
  }

  throw new ReviewerToolError("Reviewer original-prompt lookup rounds exceeded");
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
  const state: ReviewState = {
    usage: envelope.compressionUsage,
    promptLookups: [],
    consulted: new Set(),
    processing,
  };

  const candidate = config.reviewer;

  if (!candidate) throw new ReviewError("No reviewer selected; use /reviewer to choose one", []);

  signal?.throwIfAborted();
  observer.start(candidate);

  const model = registry.find(candidate.provider, candidate.model);
  let reason = unavailable(registry, candidate, model);

  if (!reason && model) reason = reviewCapacityIssue(context, model);

  let response: AssistantMessage | undefined;

  state.consulted.clear();

  try {
    if (!reason && model) {
      response = await requestCandidate(
        registry,
        candidate,
        model,
        envelope,
        config.requestTimeoutMs,
        signal,
        context,
        observer,
        state,
        availability,
      );
    }
  } catch (error) {
    signal?.throwIfAborted();

    if (isRecoveryAuditError(error) || error instanceof ReviewerToolError) {
      const detail = isRecoveryAuditError(error) ? "Provider recovery audit failed" : error.message;
      const reason = `${detail}; no fallback, nothing executed`;

      attempts.push({ ...candidate, status: "invalid", reason });

      throw new ReviewError(reason, attempts, state.usage);
    }

    if (error instanceof Error && providerRefusal(error.message)) {
      const reason = "Reviewer refused the check; no fallback, nothing executed";

      attempts.push({ ...candidate, status: "invalid", reason });

      throw new ReviewError(reason, attempts, state.usage);
    }

    reason = isProviderHeldError(error)
      ? error.message
      : error instanceof Error && error.message === "Reviewer request timed out"
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
          usage: state.usage,
          promptLookups: state.promptLookups,
        };
      }

      if (stopped.blocked) {
        attempts.push({ ...candidate, status: "invalid", reason: stopped.blocked });

        throw new ReviewError(stopped.blocked, attempts, state.usage);
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
      state.usage,
    );
  }

  let verdict: ReturnType<typeof parseVerdict>;

  try {
    verdict = parseVerdict(textContent(response!.content), envelope.requestId, envelope.goalCheck);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invalid reviewer verdict";

    attempts.push({ ...candidate, status: "invalid", reason });

    throw new ReviewError(reason, attempts, state.usage);
  }

  if (
    verdict.decision === "approve" &&
    [...(envelope.promptSources?.keys() ?? [])].some((id) => !state.consulted.has(id))
  ) {
    const reason =
      "Reviewer must inspect every compressed original before approval; no fallback, nothing executed";

    attempts.push({ ...candidate, status: "invalid", reason });

    throw new ReviewError(reason, attempts, state.usage);
  }

  attempts.push({ ...candidate, status: verdict.decision, reason: verdict.reason });

  // A valid denial is final. Never search for a model willing to approve it.
  return {
    verdict,
    selectedReviewer: candidate,
    attempts,
    usage: state.usage,
    promptLookups: state.promptLookups,
  };
}
