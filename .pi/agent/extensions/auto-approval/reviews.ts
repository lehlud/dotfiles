import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildReview, constrainReviewPayload, parseVerdict, REVIEW_SYSTEM, textContent, withWatchdog, type Config, type Reviewer } from "./policy.ts";

type Registry = Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "streamSimple">;
type Usage = AssistantMessage["usage"];
type Envelope = ReturnType<typeof buildReview>;
export type ReviewAttempt = Reviewer & { status: "failed" | "invalid" | "approve" | "deny"; reason: string };
type Observer = { start(candidate: Reviewer): void; finish(): void; failed(attempt: ReviewAttempt): void };
export const reviewerLabel = (candidate: Reviewer) => `${candidate.provider}/${candidate.model} (${candidate.thinking})`;

function refusedReview(message: string): boolean {
  return /content.filter|safety.*(?:refus|block)|(?:refus|block).*safety/i.test(message);
}

function providerFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Fixed labels only: provider errors can contain credentials or prompt text.
  if (/429|rate.?limit|quota/i.test(message)) return ": rate limit or quota unavailable";
  if (/401|403|unauthoriz|authentication|api.?key/i.test(message)) return ": provider authentication rejected; use /login for this provider";
  if (/invalid.*schema|schema.*invalid|unsupported.*param|param.*not supported/i.test(message)) return ": request schema or parameters rejected";
  if (/model.*not found|model.*does not exist|model.*not.*access/i.test(message)) return ": reviewer model unavailable";
  if (/fetch failed|ECONN|ENOTFOUND|network|connection|socket/i.test(message)) return ": provider connection unavailable";
  return "";
}

function incompleteReview(response: AssistantMessage, requestId: string) {
  try {
    const verdict = parseVerdict(textContent(response.content), requestId);
    if (verdict.decision === "deny") return { denial: verdict };
  } catch { /* An incomplete response need not contain a complete verdict. */ }
  const refused = /refusal/i.test(response.rawStopReason ?? "") || refusedReview(`${response.rawStopReason ?? ""} ${response.errorMessage ?? ""}`);
  if (refused) return { blocked: "Reviewer refused the check; no fallback, nothing executed" };
  if (response.stopReason !== "error") return { blocked: `Reviewer response is incomplete (${response.stopReason}); no fallback, nothing executed` };
  return { failure: `Reviewer provider response failed (error)${providerFailureDetail(response.errorMessage)}` };
}

export class ReviewChainError extends Error {
  constructor(message: string, public attempts: ReviewAttempt[], public usage?: Usage) { super(message); }
}

function sumUsage(current: Usage | undefined, next: Usage): Usage {
  if (!current) return structuredClone(next);
  const merged = { ...next, cost: { ...next.cost } };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) merged[key] += current[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) merged.cost[key] += current.cost[key];
  return merged;
}

function unavailable(registry: Registry, candidate: Reviewer, model: ReturnType<Registry["find"]>) {
  if (!model) return "Reviewer model not found";
  if (!registry.hasConfiguredAuth(model)) return `Reviewer authentication is unavailable. Use /login and select ${candidate.provider} on this machine; credentials are private and not synced with dotfiles.`;
  if (candidate.thinking !== "off" && (!model.reasoning || (model.thinkingLevelMap && model.thinkingLevelMap[candidate.thinking] === undefined))) return "Reviewer does not support the configured thinking level";
}

async function requestReview(registry: Registry, candidate: Reviewer, model: NonNullable<ReturnType<Registry["find"]>>, envelope: Envelope, timeoutMs: number, signal: AbortSignal | undefined, systemPrompt: string) {
  return await withWatchdog(async (reviewSignal) => registry.streamSimple(model, {
    systemPrompt,
    messages: [{ role: "user", content: envelope.text, timestamp: Date.now() }],
    // The reviewer receives no tools and cannot execute or delegate.
  }, {
    reasoning: candidate.thinking === "off" ? undefined : candidate.thinking,
    signal: reviewSignal, maxTokens: 4096, cacheRetention: "short", sessionId: envelope.requestId,
    onPayload: (payload, providerModel) => constrainReviewPayload(payload, providerModel, envelope.requestId),
  }).result(), timeoutMs, signal);
}

export async function reviewWithFallback(config: Config, registry: Registry, envelope: Envelope, observer: Observer, signal?: AbortSignal, systemPrompt = REVIEW_SYSTEM) {
  const attempts: ReviewAttempt[] = [];
  let usage: Usage | undefined;
  for (const candidate of config.reviewers) {
    signal?.throwIfAborted();
    observer.start(candidate);
    const model = registry.find(candidate.provider, candidate.model);
    let reason = unavailable(registry, candidate, model);
    let response: AssistantMessage | undefined;
    try {
      if (!reason && model) response = await requestReview(registry, candidate, model, envelope, config.requestTimeoutMs, signal, systemPrompt);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && refusedReview(error.message)) {
        const reason = "Reviewer refused the check; no fallback, nothing executed";
        attempts.push({ ...candidate, status: "invalid", reason });
        throw new ReviewChainError(reason, attempts, usage);
      }
      reason = error instanceof Error && error.message === "Reviewer request timed out" ? error.message : `Reviewer provider request failed${providerFailureDetail(error)}`;
    } finally { observer.finish(); }
    signal?.throwIfAborted();
    if (response) {
      usage = sumUsage(usage, response.usage);
      if (response.stopReason !== "stop") {
        // An explicit request-bound denial stays final even if transport fails
        // after delivering it. An approval from a failed response is never used.
        const stopped = incompleteReview(response, envelope.requestId);
        if (stopped.denial) {
          attempts.push({ ...candidate, status: "deny", reason: stopped.denial.reason });
          return { verdict: stopped.denial, selectedReviewer: candidate, attempts, usage };
        }
        if (stopped.blocked) {
          attempts.push({ ...candidate, status: "invalid", reason: stopped.blocked });
          throw new ReviewChainError(stopped.blocked, attempts, usage);
        }
        reason = stopped.failure;
      }
    }
    if (reason) {
      const attempt: ReviewAttempt = { ...candidate, status: "failed", reason };
      attempts.push(attempt);
      // A failed audit/display callback aborts the chain, never authorizes a retry.
      observer.failed(attempt);
      continue;
    }
    let verdict: ReturnType<typeof parseVerdict>;
    try { verdict = parseVerdict(textContent(response!.content), envelope.requestId); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "Invalid reviewer verdict";
      attempts.push({ ...candidate, status: "invalid", reason });
      throw new ReviewChainError(reason, attempts, usage);
    }
    attempts.push({ ...candidate, status: verdict.decision, reason: verdict.reason });
    // A valid denial is final. Never search for a model willing to approve it.
    return { verdict, selectedReviewer: candidate, attempts, usage };
  }
  throw new ReviewChainError(`No configured reviewer completed the check: ${attempts.map((item) => `${reviewerLabel(item)}: ${item.reason}`).join("; ")}`, attempts, usage);
}
