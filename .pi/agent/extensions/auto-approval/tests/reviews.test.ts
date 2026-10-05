import { test, expect, beforeEach } from "bun:test";
import { reviewWithFallback, ReviewChainError, type ReviewAttempt } from "../reviews.ts";
import { buildReview, type Config } from "../policy.ts";

const primary = { provider: "openai", model: "gpt-6-luna", thinking: "medium" as const };
const fallback = { provider: "openrouter", model: "openai/gpt-6-luna", thinking: "medium" as const };
const config: Config = { reviewers: [primary, fallback], recentUserPrompts: 6, requestTimeoutMs: 120000, sandbox: { backend: "bwrap", executable: "/usr/bin/bwrap", runnerExecutable: "/executor/runner" } };
const envelope = buildReview({ tool: "bash", arguments: { command: "printf synthetic" }, goal: "Smoke test", justification: "Synthetic test" }, [{ type: "message", message: { role: "user", content: "Run a harmless synthetic smoke test" } }], config, "/tmp", []);
const usage = { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 } };
type Mode = "approve" | "deny" | "missing" | "auth" | "unsupported" | "error" | "error_deny" | "length" | "filtered" | "aborted" | "throw" | "throw_refusal" | "timeout" | "invalid" | "mismatch";
let modes: Record<string, Mode>;
let calls: any[];
let attempts: ReviewAttempt[];
let starts: string[];
let finishes: number;
let onResponse: (() => void) | undefined;
beforeEach(() => { modes = {}; calls = []; attempts = []; starts = []; finishes = 0; onResponse = undefined; });
const observer = {
  start: (candidate: { provider: string }) => { starts.push(candidate.provider); },
  finish: () => { finishes++; },
  failed: (attempt: ReviewAttempt) => { attempts.push(attempt); },
};
function message(provider: string) {
  const mode = modes[provider];
  const stopReason = mode === "length" || mode === "aborted" ? mode : ["error", "error_deny", "filtered"].includes(mode) ? "error" : "stop";
  return { stopReason, rawStopReason: mode === "filtered" ? "incomplete.content_filter" : undefined, usage, content: [{ type: "text", text: mode === "invalid" ? "not JSON" : JSON.stringify({ requestId: mode === "mismatch" ? "other-action" : envelope.requestId, decision: mode === "deny" || mode === "error_deny" ? "deny" : "approve", reason: "Synthetic verdict" }) }] };
}
const registry: any = {
  find: (provider: string, id: string) => modes[provider] === "missing" ? undefined : { provider, id, reasoning: modes[provider] !== "unsupported", api: "openai-responses", thinkingLevelMap: { medium: "medium" } },
  hasConfiguredAuth: (model: { provider: string }) => modes[model.provider] !== "auth",
  streamSimple: (model: any, context: any, options: any) => {
    calls.push({ model, context, options });
    return { result: async () => {
      onResponse?.();
      if (modes[model.provider] === "throw") throw new Error("HTTP 429 with synthetic-private-error-content");
      if (modes[model.provider] === "throw_refusal") throw new Error("Request blocked by safety policy with synthetic-private-error-content");
      if (modes[model.provider] === "timeout") await new Promise((done) => setTimeout(done, 35));
      return message(model.provider);
    } };
  },
};
const run = (settings = config, signal?: AbortSignal, callbacks = observer) => reviewWithFallback(settings, registry, envelope, callbacks, signal);

test("highest-priority success stops the chain and preserves request-bound output", async () => {
  const result = await run();
  expect(result.selectedReviewer).toEqual(primary); expect(calls).toHaveLength(1);
  expect(result.usage).toEqual(usage); expect(attempts).toHaveLength(0);
  expect(calls[0].context.tools).toBeUndefined();
  const payload = calls[0].options.onPayload({}, calls[0].model);
  expect(payload.text.format.schema.properties.requestId.enum).toEqual([envelope.requestId]);
});
test("explicit fallback is used for missing auth, missing models and unsupported thinking", async () => {
  for (const mode of ["auth", "missing", "unsupported"] as const) {
    modes.openai = mode;
    const result = await run();
    expect(result.selectedReviewer).toEqual(fallback);
    expect(result.attempts.map((item) => item.status)).toEqual(["failed", "approve"]);
    expect(calls.at(-1).model.provider).toBe("openrouter");
    expect(calls.at(-1).model.id).toBe("openai/gpt-6-luna");
  }
});
test("provider failures fall back without exposing raw provider error content", async () => {
  modes.openai = "throw";
  const result = await run();
  expect(result.selectedReviewer).toEqual(fallback);
  expect(result.attempts[0].reason).toBe("Reviewer provider request failed: rate limit or quota unavailable");
  expect(JSON.stringify(result)).not.toContain("synthetic-private-error-content");
  expect(result.usage).toEqual(usage);
});
test("failed provider responses and successful fallback usage are both counted", async () => {
  modes.openai = "error";
  const result = await run();
  expect(result.usage?.input).toBe(4); expect(result.usage?.totalTokens).toBe(12);
  expect(result.usage?.cost.total).toBeCloseTo(0.62);
  expect(result.attempts[0].status).toBe("failed");
  expect(calls.map((item) => item.context.messages[0].content)).toEqual([envelope.text, envelope.text]);
});
test("valid denial is binding even when the fallback would approve", async () => {
  modes.openai = "deny";
  const result = await run();
  expect(result.verdict.decision).toBe("deny"); expect(result.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(1); expect(attempts).toHaveLength(0);
});
test("denial remains final when a provider error follows the complete verdict", async () => {
  modes.openai = "error_deny";
  const result = await run();
  expect(result.verdict.decision).toBe("deny");
  expect(result.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(1);
});
test("truncated, refused or aborted model responses never consult a fallback", async () => {
  for (const mode of ["length", "filtered", "aborted", "throw_refusal"] as const) {
    modes.openai = mode; calls = [];
    await expect(run()).rejects.toThrow("no fallback");
    expect(calls).toHaveLength(1);
  }
});
test("malformed or mismatched verdicts fail closed without consulting the fallback", async () => {
  for (const mode of ["invalid", "mismatch"] as const) {
    modes.openai = mode; calls = [];
    try { await run(); throw new Error("Expected invalid verdict rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(ReviewChainError);
      expect((error as ReviewChainError).attempts.at(-1)?.status).toBe("invalid");
    }
    expect(calls).toHaveLength(1);
  }
});
test("an unconfigured fallback is never used and all failures retain diagnostics", async () => {
  modes.openai = "auth";
  await expect(run({ ...config, reviewers: [primary] })).rejects.toThrow("No configured reviewer");
  expect(starts).toEqual(["openai"]); expect(calls).toHaveLength(0);
  modes.openrouter = "auth";
  try { await run(); throw new Error("Expected all reviewers unavailable"); }
  catch (error) { expect((error as ReviewChainError).attempts).toHaveLength(2); }
});
test("timeout uses only the configured fallback and ignores late results", async () => {
  modes.openai = "timeout";
  const result = await run({ ...config, requestTimeoutMs: 5 });
  expect(result.selectedReviewer).toEqual(fallback); expect(result.attempts[0].reason).toContain("timed out");
  await new Promise((done) => setTimeout(done, 40));
  expect(result.selectedReviewer).toEqual(fallback); expect(calls).toHaveLength(2);
  expect(finishes).toBe(2);
});
test("cancellation prevents fallback before and during review", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await expect(run(config, cancelled.signal)).rejects.toThrow(); expect(calls).toHaveLength(0);
  const controller = new AbortController(); onResponse = () => controller.abort();
  await expect(run(config, controller.signal)).rejects.toThrow();
  expect(calls).toHaveLength(1); expect(attempts).toHaveLength(0);
});
test("failed fallback audit callbacks abort the chain", async () => {
  modes.openai = "auth";
  await expect(run(config, undefined, { ...observer, failed() { throw new Error("Audit unavailable"); } })).rejects.toThrow("Audit unavailable");
  expect(starts).toEqual(["openai"]); expect(calls).toHaveLength(0);
});
test("each new action starts at the highest priority, with no cached route", async () => {
  modes.openai = "auth"; expect((await run()).selectedReviewer).toEqual(fallback);
  modes.openai = "approve"; expect((await run()).selectedReviewer).toEqual(primary);
  expect(starts).toEqual(["openai", "openrouter", "openai"]);
});
