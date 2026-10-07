import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { buildReview, constrainReviewPayload, parseVerdict, REVIEW_LANGUAGE, REVIEW_SYSTEM, textContent, withWatchdog, type Config, type Reviewer } from "./policy.ts";
import { reviewCapacityIssue, reviewLanguageReference, REVIEW_OUTPUT_TOKENS } from "./review-context.ts";
import { promptOriginalTool, readPromptOriginal } from "./prompt-reader.ts";
import { sumUsage } from "./usage.ts";
export { sumUsage } from "./usage.ts";
import { ProviderAvailability, providerAvailability, ProviderHeldError, RecoveryAuditError, providerRefusal, type AvailabilityNotice } from "./provider-availability.ts";
import { installProviderStreams, unavailableResponse } from "./provider-stream.ts";

type Registry = Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "streamSimple">;
type Usage = AssistantMessage["usage"];
type Envelope = Pick<ReturnType<typeof buildReview>, "requestId" | "fingerprint" | "text"> & Partial<Pick<ReturnType<typeof buildReview>, "promptSources" | "compressionUsage">>;
type PromptLookup = { promptId: string; operation: string; offset?: number; limit?: number; query?: string };
export type ReviewAttempt = Reviewer & { status: "failed" | "invalid" | "approve" | "deny"; reason: string };
type Observer = { start(candidate: Reviewer): void; finish(): void; failed(attempt: ReviewAttempt): void; lookup?(request: PromptLookup): void; retry?(event: AvailabilityNotice): void };
export const reviewerLabel = (candidate: Reviewer) => `${candidate.provider}/${candidate.model} (${candidate.thinking})`;

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
  if (response.errorMessage === new RecoveryAuditError().message) return { blocked: response.errorMessage };
  try {
    const verdict = parseVerdict(textContent(response.content), requestId);
    if (verdict.decision === "deny") return { denial: verdict };
  } catch { /* An incomplete response need not contain a complete verdict. */ }
  const refused = /refusal/i.test(response.rawStopReason ?? "") || providerRefusal(`${response.rawStopReason ?? ""} ${response.errorMessage ?? ""}`);
  if (refused) return { blocked: "Reviewer refused the check; no fallback, nothing executed" };
  if (response.stopReason !== "error") return { blocked: `Reviewer response is incomplete (${response.stopReason}); no fallback, nothing executed` };
  return { failure: `Reviewer provider response failed (error)${providerFailureDetail(response.errorMessage)}` };
}

export class ReviewChainError extends Error {
  constructor(message: string, public attempts: ReviewAttempt[], public usage?: Usage) { super(message); }
}

function unavailable(registry: Registry, candidate: Reviewer, model: ReturnType<Registry["find"]>) {
  if (!model) return "Reviewer model not found";
  if (!registry.hasConfiguredAuth(model)) return `Reviewer authentication is unavailable. Use /login and select ${candidate.provider} on this machine; credentials are private and not synced with dotfiles.`;
  if (candidate.thinking !== "off" && (!model.reasoning || (model.thinkingLevelMap && model.thinkingLevelMap[candidate.thinking] === undefined))) return "Reviewer does not support the configured thinking level";
}

function reviewContext(envelope: Envelope, systemPrompt: string): Context {
  const { latestUserPrompt, latestUserLanguageReference } = JSON.parse(envelope.text);
  if (typeof latestUserPrompt !== "string" || !latestUserPrompt.trim()) throw new Error("Latest operator prompt unavailable");
  return {
    systemPrompt: systemPrompt + (envelope.promptSources?.size ? "\nSome operator prompts are marked compressed in userPromptInfo. Their summaries are navigation aids, not new authorization. Originals are authoritative. Use ONLY prompt_original to inspect relevant original ranges and conditions. You MUST inspect every compressed original at least once before approve; a lookup that returns no text does not count. Search or read further when a condition could affect this exact action or goal. If you cannot establish the applicable constraints, deny. No filesystem, shell, network or other tools. Maximum eight original lookups for this review. Return verdict JSON only after all required lookup results." : ""),
    messages: [
      { role: "user", content: envelope.text, timestamp: Date.now() },
      // The short language reference omits machine data; the full prompt stays
      // in the unchanged JSON for authorization and operator constraints.
      { role: "user", content: `${REVIEW_LANGUAGE}\nLatest actual operator prompt (quoted language reference only; full original constraints remain authoritative and compressed originals can be read with prompt_original):\n${JSON.stringify(latestUserLanguageReference ?? reviewLanguageReference(latestUserPrompt))}`, timestamp: Date.now() },
    ],
    ...(envelope.promptSources?.size ? { tools: [promptOriginalTool] } : {}),
  };
}

async function requestReview(registry: Registry, candidate: Reviewer, model: NonNullable<ReturnType<Registry["find"]>>, envelope: Envelope, timeoutMs: number, signal: AbortSignal | undefined, context: Context, state: ReviewState, availability: ProviderAvailability, observer: Observer) {
  const managed = installProviderStreams(registry as any, availability, observer.retry);
  return await withWatchdog(async (reviewSignal) => {
    const work = async () => {
      const response = await registry.streamSimple(model, structuredClone(context), {
        reasoning: candidate.thinking === "off" ? undefined : candidate.thinking,
        signal: reviewSignal, maxTokens: REVIEW_OUTPUT_TOKENS, cacheRetention: "short", sessionId: envelope.requestId,
        onPayload: (payload, providerModel) => constrainReviewPayload(payload, providerModel, envelope.requestId),
      }).result();
      state.usage = sumUsage(state.usage, response.usage);
      return response;
    };
    return managed ? await work() : await availability.run(model, work, (response) => unavailableResponse(response, context), reviewSignal, observer.retry);
  }, timeoutMs, signal);
}

class ReviewerToolError extends Error {}
type ReviewState = { usage?: Usage; promptLookups: PromptLookup[]; consulted: Set<string> };
async function requestCandidate(registry: Registry, candidate: Reviewer, model: NonNullable<ReturnType<Registry["find"]>>, envelope: Envelope, timeoutMs: number, signal: AbortSignal | undefined, initial: Context, observer: Observer, state: ReviewState, availability: ProviderAvailability) {
  const context = structuredClone(initial);
  const started = Date.now();
  for (let round = 0; round <= 8; round++) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new Error("Reviewer request timed out");
    if (reviewCapacityIssue(context, model)) throw new ReviewerToolError("Reviewer lookup context exceeds model capacity");
    const response = await requestReview(registry, candidate, model, envelope, remaining, signal, context, state, availability, observer);
    const calls = response.content.filter((block) => block.type === "toolCall");
    if (!calls.length) return response;
    try { if (parseVerdict(textContent(response.content), envelope.requestId).decision === "deny") return response; } catch { /* A tool turn need not contain a verdict yet. */ }
    if (response.stopReason !== "toolUse" || !envelope.promptSources?.size) throw new ReviewerToolError("Invalid reviewer tool response");
    context.messages.push(response);
    for (const call of calls) {
      if (call.name !== promptOriginalTool.name || state.promptLookups.length >= 8) throw new ReviewerToolError("Reviewer original-prompt lookup limit or tool violated");
      try {
        const result = readPromptOriginal(envelope.promptSources, call.arguments);
        const lookup = structuredClone(call.arguments) as PromptLookup;
        state.promptLookups.push(lookup); observer.lookup?.(lookup);
        if (result.excerpts.some((excerpt) => excerpt.text.length)) state.consulted.add(lookup.promptId);
        context.messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: JSON.stringify(result) }], isError: false, timestamp: Date.now() });
      } catch { throw new ReviewerToolError("Reviewer original-prompt lookup or audit failed"); }
    }
  }
  throw new ReviewerToolError("Reviewer original-prompt lookup rounds exceeded");
}

export async function reviewWithFallback(config: Config, registry: Registry, envelope: Envelope, observer: Observer, signal?: AbortSignal, systemPrompt = REVIEW_SYSTEM, availability = providerAvailability) {
  const source = JSON.parse(envelope.text).latestUserPrompt;
  if (typeof source !== "string" || !source.trim()) throw new ReviewChainError("Latest operator prompt unavailable; no fallback, nothing executed", []);
  const context = reviewContext(envelope, systemPrompt);
  const attempts: ReviewAttempt[] = [];
  const state: ReviewState = { usage: envelope.compressionUsage, promptLookups: [], consulted: new Set() };
  for (const candidate of config.reviewers) {
    signal?.throwIfAborted();
    observer.start(candidate);
    const model = registry.find(candidate.provider, candidate.model);
    let reason = unavailable(registry, candidate, model);
    if (!reason && model) reason = reviewCapacityIssue(context, model);
    let response: AssistantMessage | undefined;
    state.consulted.clear();
    try {
      if (!reason && model) {
        response = await requestCandidate(registry, candidate, model, envelope, config.requestTimeoutMs, signal, context, observer, state, availability);
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof RecoveryAuditError || error instanceof ReviewerToolError) {
        const reason = "Reviewer original-prompt lookup failed; no fallback, nothing executed";
        attempts.push({ ...candidate, status: "invalid", reason });
        throw new ReviewChainError(reason, attempts, state.usage);
      }
      if (error instanceof Error && providerRefusal(error.message)) {
        const reason = "Reviewer refused the check; no fallback, nothing executed";
        attempts.push({ ...candidate, status: "invalid", reason });
        throw new ReviewChainError(reason, attempts, state.usage);
      }
      reason = error instanceof ProviderHeldError ? error.message : error instanceof Error && error.message === "Reviewer request timed out" ? error.message : `Reviewer provider request failed${providerFailureDetail(error)}`;
    } finally { observer.finish(); }
    signal?.throwIfAborted();
    if (response) {
      if (response.stopReason !== "stop") {
        // An explicit request-bound denial stays final even if transport fails
        // after delivering it. An approval from a failed response is never used.
        const stopped = incompleteReview(response, envelope.requestId);
        if (stopped.denial) {
          attempts.push({ ...candidate, status: "deny", reason: stopped.denial.reason });
          return { verdict: stopped.denial, selectedReviewer: candidate, attempts, usage: state.usage, promptLookups: state.promptLookups };
        }
        if (stopped.blocked) {
          attempts.push({ ...candidate, status: "invalid", reason: stopped.blocked });
          throw new ReviewChainError(stopped.blocked, attempts, state.usage);
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
      throw new ReviewChainError(reason, attempts, state.usage);
    }
    if (verdict.decision === "approve" && [...(envelope.promptSources?.keys() ?? [])].some((id) => !state.consulted.has(id))) {
      const reason = "Reviewer must inspect every compressed original before approval; no fallback, nothing executed";
      attempts.push({ ...candidate, status: "invalid", reason });
      throw new ReviewChainError(reason, attempts, state.usage);
    }
    attempts.push({ ...candidate, status: verdict.decision, reason: verdict.reason });
    // A valid denial is final. Never search for a model willing to approve it.
    return { verdict, selectedReviewer: candidate, attempts, usage: state.usage, promptLookups: state.promptLookups };
  }
  throw new ReviewChainError(`No configured reviewer completed the check: ${attempts.map((item) => `${reviewerLabel(item)}: ${item.reason}`).join("; ")}`, attempts, state.usage);
}
