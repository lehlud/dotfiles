import type { Context } from "@earendil-works/pi-ai";
import type {
  ReviewRegistry,
  ReviewProcessing,
  ReviewObserver,
  ReviewEnvelope,
  Usage,
  ReviewAttempt,
} from "./contracts.ts";
import type { Reviewer } from "./protocol.ts";
import type { PromptLookup } from "./originals.ts";
import {
  constrainReviewPayload,
  parseVerdict,
  RequestIdMismatchError,
  textContent,
  withWatchdog,
} from "./protocol.ts";
import { reviewCapacityIssue, REVIEW_OUTPUT_TOKENS } from "./context.ts";
import { originalLookupTurn, ReviewerToolError } from "./original-turn.ts";
import { sumUsage } from "../providers/usage.ts";
import type { ProviderAvailability } from "../providers/availability.ts";
import { installProviderStreams, unavailableResponse } from "../providers/stream.ts";
import { cacheReviewPayload, reviewCacheKey, reviewCacheRetention } from "./cache.ts";
import { fastPayload } from "../providers/fast.ts";

type ReviewModel = NonNullable<ReturnType<ReviewRegistry["find"]>>;

type ExchangeOptions = {
  registry: ReviewRegistry;
  candidate: Reviewer;
  envelope: ReviewEnvelope;
  context: Context;
  timeoutMs: number;
  signal?: AbortSignal;
  observer: ReviewObserver;
  availability: ProviderAvailability;
  processing: ReviewProcessing;
  attempts: ReviewAttempt[];
};

const REQUEST_ID_RETRIES = 3;

export function originalLookupBudget(envelope: ReviewEnvelope): number {
  // Every compressed prompt must fit, with room for targeted follow-up reads.
  // The shared deadline and model-context checks bound the total work.
  return Math.max(8, (envelope.promptSources?.size ?? 0) + 4);
}

/** One request's transport, lookup transcript and billing; verdict policy stays in client.ts. */
export class ReviewExchange {
  usage?: Usage;
  readonly promptLookups: PromptLookup[] = [];
  readonly consulted = new Set<string>();
  private idRetries = 0;
  constructor(private options: ExchangeOptions) {
    this.usage = options.envelope.compressionUsage;
  }

  async run(model: ReviewModel) {
    return withWatchdog(
      (signal) => this.exchange(model, signal),
      this.options.timeoutMs,
      this.options.signal,
    );
  }

  private async exchange(model: ReviewModel, signal: AbortSignal) {
    const { envelope, observer } = this.options;
    const context = structuredClone(this.options.context);
    const lookupBudget = originalLookupBudget(envelope);
    const lookups = {
      attempts: 0,
      failures: 0,
      limit: lookupBudget,
      promptLookups: this.promptLookups,
      consulted: this.consulted,
    };

    for (let round = 0; round <= lookupBudget; ) {
      signal.throwIfAborted();

      if (reviewCapacityIssue(context, model))
        throw new ReviewerToolError("Reviewer lookup context exceeds model capacity");

      const response = await this.request(model, context, signal);
      const calls = response.content.filter((block) => block.type === "toolCall");

      if (!calls.length) {
        if (
          response.stopReason === "stop" &&
          this.retryRequestId(textContent(response.content), context)
        )
          continue;

        return response;
      }

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

      round++;
      context.messages.push(response);

      for (const call of calls) {
        context.messages.push(originalLookupTurn(call, sources, lookups, observer));
      }
    }

    throw new ReviewerToolError("Reviewer original-prompt lookup rounds exceeded");
  }

  /** Discard stale verdicts, never relabel them or retry a request-bound denial. */
  private retryRequestId(text: string, context: Context): boolean {
    const { envelope, observer, candidate, attempts } = this.options;

    try {
      parseVerdict(text, envelope.requestId, envelope.goalCheck);

      return false;
    } catch (error) {
      if (!(error instanceof RequestIdMismatchError) || this.idRetries >= REQUEST_ID_RETRIES)
        return false;
    }

    this.idRetries++;

    const attempt: ReviewAttempt = {
      ...candidate,
      status: "invalid",
      reason: `Reviewer requestId mismatch; repeating the same review (${this.idRetries}/${REQUEST_ID_RETRIES}); nothing executed`,
    };

    attempts.push(attempt);

    try {
      observer.failed(attempt);
    } catch {
      throw new ReviewerToolError("Reviewer request-ID retry audit failed");
    }

    context.messages.push({
      role: "user",
      content: `Transport protocol correction (not operator authorization): the previous verdict belonged to another request and was discarded. Reassess the complete current envelope and return fresh verdict JSON with requestId exactly ${JSON.stringify(envelope.requestId)}. Do not relabel a previous verdict. Keep the same evidence and approval criteria.`,
      timestamp: Date.now(),
    });

    return true;
  }

  private async request(model: ReviewModel, context: Context, signal: AbortSignal) {
    const { registry, candidate, envelope, availability, observer, processing } = this.options;
    const managed = installProviderStreams(registry, availability, observer.retry);
    const work = async () => {
      const fast = processing.fastMode?.() ?? false;
      const response = await registry
        .streamSimple(model, structuredClone(context), {
          reasoning: candidate.thinking === "off" ? undefined : candidate.thinking,
          signal,
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

      this.usage = sumUsage(this.usage, response.usage);

      return response;
    };

    return managed
      ? work()
      : availability.run(
          model,
          work,
          (response) => unavailableResponse(response, context),
          signal,
          observer.retry,
        );
  }
}
