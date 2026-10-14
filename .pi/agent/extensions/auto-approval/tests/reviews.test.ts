import { test, expect, beforeEach } from "bun:test";
import { reviewWithFallback } from "../review.ts";
import { ReviewChainError, type ReviewAttempt } from "../../shared/review/client.ts";
import { buildReview } from "../review.ts";
import { type Config } from "../../shared/configuration/schemas.ts";
import { multiplexReviewFixtures } from "./multiplex-review-fixtures.ts";
import { ProviderAvailability } from "../../shared/providers/availability.ts";
import { expiredTokenResponse } from "./provider-error-fixtures.ts";
import { steeringReviewFixtures } from "./steering-review-fixtures.ts";

const primary = { provider: "openai", model: "gpt-6-luna", thinking: "medium" as const };
const fallback = {
  provider: "openrouter",
  model: "openai/gpt-6-luna",
  thinking: "medium" as const,
};
const config: Config = {
  reviewers: [primary, fallback],
  recentUserPrompts: 6,
  requestTimeoutMs: 120000,
  sandbox: { backend: "bwrap", executable: "/usr/bin/bwrap", runnerExecutable: "/executor/runner" },
};
const envelope = buildReview(
  {
    tool: "bash",
    arguments: { command: "printf synthetic" },
    goal: "Smoke test",
    justification: "Synthetic test",
  },
  [{ type: "message", message: { role: "user", content: "Run a harmless synthetic smoke test" } }],
  config,
  "/tmp",
  [],
);
const usage = {
  input: 2,
  output: 3,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 6,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
};

type Mode =
  | "approve"
  | "deny"
  | "missing"
  | "auth"
  | "unsupported"
  | "error"
  | "error_deny"
  | "expired"
  | "expired_deny"
  | "length"
  | "filtered"
  | "aborted"
  | "throw"
  | "throw_refusal"
  | "cyber_refusal"
  | "throw_cyber_refusal"
  | "timeout"
  | "invalid"
  | "mismatch";

let modes: Record<string, Mode>;
let calls: any[];
let attempts: ReviewAttempt[];
let starts: string[];
let finishes: number;
let onResponse: (() => void) | undefined;
let capacities: Record<string, number>;
let availability: ProviderAvailability;
let clock: number;

beforeEach(() => {
  modes = {};
  calls = [];
  attempts = [];
  starts = [];
  finishes = 0;
  onResponse = undefined;
  capacities = {};
  clock = 0;
  availability = new ProviderAvailability({
    now: () => clock,
    wait: async (ms, signal) => {
      signal?.throwIfAborted();
      clock += ms;
    },

  });
});

const observer = {
  start: (candidate: { provider: string }) => {
    starts.push(candidate.provider);
  },

  finish: () => {
    finishes++;
  },

  failed: (attempt: ReviewAttempt) => {
    attempts.push(attempt);
  },

};

function message(provider: string, requestId = envelope.requestId) {
  const mode = modes[provider];
  const stopReason =
    mode === "length" || mode === "aborted"
      ? mode
      : ["error", "error_deny", "expired", "expired_deny", "filtered", "cyber_refusal"].includes(
            mode,
          )
        ? "error"
        : "stop";

  return {
    stopReason,
    errorMessage:
      mode === "cyber_refusal"
        ? "HTTP 503: This content was flagged for possible cybersecurity risk. Check access_programs.cyber."
        : mode === "expired" || mode === "expired_deny"
          ? expiredTokenResponse
          : undefined,
    rawStopReason: mode === "filtered" ? "incomplete.content_filter" : undefined,
    usage,
    content: [
      {
        type: "text",
        text:
          mode === "invalid"
            ? "not JSON"
            : JSON.stringify({
                requestId: mode === "mismatch" ? "other-action" : requestId,
                decision: ["deny", "error_deny", "expired_deny"].includes(mode)
                  ? "deny"
                  : "approve",
                reason: "Synthetic verdict",
              }),
      },
    ],
  };
}

const registry: any = {
  find: (provider: string, id: string) =>
    modes[provider] === "missing"
      ? undefined
      : {
          provider,
          id,
          contextWindow: capacities[provider] ?? 272000,
          maxTokens: 128000,
          reasoning: modes[provider] !== "unsupported",
          api: "openai-responses",
          thinkingLevelMap: { medium: "medium" },
        },
  hasConfiguredAuth: (model: { provider: string }) => modes[model.provider] !== "auth",
  streamSimple: (model: any, context: any, options: any) => {
    calls.push({ model, context, options });

    return {
      result: async () => {
        onResponse?.();

        if (modes[model.provider] === "throw")
          throw new Error("HTTP 429 with synthetic-private-error-content");

        if (modes[model.provider] === "throw_cyber_refusal")
          throw new Error(
            "HTTP 503: This content was flagged for possible cybersecurity risk. Check access_programs.cyber.",
          );

        if (modes[model.provider] === "throw_refusal")
          throw new Error("Request blocked by safety policy with synthetic-private-error-content");

        if (modes[model.provider] === "timeout") await new Promise((done) => setTimeout(done, 35));

        return message(model.provider, JSON.parse(context.messages[0].content).requestId);
      },

    };
  },

};
const run = (settings = config, signal?: AbortSignal, callbacks = observer) =>
  reviewWithFallback(settings, registry, envelope, callbacks, signal, undefined, availability);

test("the first reviewer request eagerly carries ten legacy inputs and does not repeat only the latest correction", async () => {
  const fixture = steeringReviewFixtures[0];
  const request = buildReview(fixture.action, fixture.entries, config, "/project", []);

  await reviewWithFallback(config, registry, request, observer, undefined, undefined, availability);

  expect(calls).toHaveLength(1);
  expect(calls[0].context.messages).toHaveLength(1);

  const data = JSON.parse(calls[0].context.messages[0].content);

  expect(data.userPrompts).toHaveLength(10);
  expect(data.userPrompts[0]).toContain("Finish the Flutter client migration");
  expect(data.userPrompts[1]).toContain("human readability");
  expect(data.latestUserPrompt).toContain("Make nullable fields optional");
  expect(data.userPromptInfo.every((info: any) => info.inputKind === "unknown")).toBe(true);
  expect(data.userPromptInfo.every((info: any) => info.isSteering === null)).toBe(true);
  expect(data.previousDenials[0].reason).toContain("formatting-only");
  expect(calls[0].context.tools).toBeUndefined();
});

test("highest-priority success stops the chain and preserves request-bound output", async () => {
  const result = await run();

  expect(result.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(1);
  expect(result.usage).toEqual(usage);
  expect(attempts).toHaveLength(0);
  expect(calls[0].context.tools).toBeUndefined();
  expect(calls[0].context.messages.at(-1).content).toContain(
    JSON.parse(envelope.text).latestUserPrompt,
  );
  expect(calls[0].context.messages).toHaveLength(1);

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
  expect(result.attempts[0].reason).toContain("availability guard for 300 seconds");
  expect(calls.filter((item) => item.model.provider === "openai")).toHaveLength(6);
  expect(JSON.stringify(result)).not.toContain("synthetic-private-error-content");
  expect(result.usage).toEqual(usage);
});

test("failed provider responses and successful fallback usage are both counted", async () => {
  modes.openai = "error";

  const result = await run();

  expect(result.usage?.input).toBe(4);
  expect(result.usage?.totalTokens).toBe(12);
  expect(result.usage?.cost.total).toBeCloseTo(0.62);
  expect(result.attempts[0].status).toBe("failed");
  expect(calls.map((item) => item.context.messages[0].content)).toEqual([
    envelope.text,
    envelope.text,
  ]);
});

test("valid denial is binding even when the fallback would approve", async () => {
  modes.openai = "deny";

  const result = await run();

  expect(result.verdict.decision).toBe("deny");
  expect(result.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(1);
  expect(attempts).toHaveLength(0);
});

test("capacity preflight includes system, envelope language metadata and output reserve", async () => {
  capacities.openai = 8000;

  const result = await run();

  expect(result.selectedReviewer).toEqual(fallback);
  expect(result.attempts[0].reason).toContain("context capacity unavailable");
  expect(calls).toHaveLength(1);
  expect(calls[0].model.provider).toBe("openrouter");
  capacities.openrouter = 8000;
  calls = [];
  await expect(run()).rejects.toThrow("operator context and action were not truncated");
  expect(calls).toHaveLength(0);
});

test("large operator context is sent intact to a capable model and a denial stays final", async () => {
  const prompt =
    "Prüfe diese JSON-Ergebnisse, ohne Zugangsdaten zu lesen: " + "abcdef".repeat(20000);
  const large = buildReview(
    {
      tool: "read",
      arguments: { path: "snail/reference/snail.c", offset: 82, limit: 35 },
      goal: "Inspect",
      justification: "Test diagnosis",
    },
    [{ type: "message", message: { role: "user", content: prompt } }],
    config,
    "/project",
    [],
  );

  modes.openai = "deny";

  const gate = {
    ...registry,
    streamSimple(model: any, context: any, options: any) {
      calls.push({ model, context, options });

      return {
        result: async () => ({
          ...message(model.provider),
          content: [
            {
              type: "text",
              text: JSON.stringify({
                requestId: large.requestId,
                decision: "deny",
                reason: "Nicht autorisiert.",
              }),
            },
          ],
        }),
      };
    },

  };
  const result = await reviewWithFallback(config, gate, large, observer);

  expect(result.verdict.decision).toBe("deny");
  expect(calls).toHaveLength(1);
  expect(calls[0].context.messages[0].content).toBe(large.text);
  expect(calls[0].context.messages).toHaveLength(1);
  expect(JSON.parse(calls[0].context.messages[0].content).latestUserLanguageReference).toContain(
    "Language sample shortened",
  );
  expect(
    JSON.parse(calls[0].context.messages[0].content).latestUserLanguageReference.length,
  ).toBeLessThan(3500);
});

test("denial remains final when a provider error follows the complete verdict", async () => {
  modes.openai = "error_deny";

  const result = await run();

  expect(result.verdict.decision).toBe("deny");
  expect(result.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(1);
});

test("truncated, refused or aborted model responses never consult a fallback", async () => {
  for (const mode of [
    "length",
    "filtered",
    "aborted",
    "throw_refusal",
    "cyber_refusal",
    "throw_cyber_refusal",
  ] as const) {
    modes.openai = mode;
    calls = [];
    await expect(run()).rejects.toThrow("no fallback");
    expect(calls).toHaveLength(1);
  }

});

test("malformed or mismatched verdicts fail closed without consulting the fallback", async () => {
  for (const mode of ["invalid", "mismatch"] as const) {
    modes.openai = mode;
    calls = [];

    try {
      await run();

      throw new Error("Expected invalid verdict rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewChainError);
      expect((error as ReviewChainError).attempts.at(-1)?.status).toBe("invalid");
    }

    expect(calls).toHaveLength(1);
  }

});

test("an unconfigured fallback is never used and all failures retain diagnostics", async () => {
  modes.openai = "auth";
  await expect(run({ ...config, reviewers: [primary] })).rejects.toThrow("No configured reviewer");
  expect(starts).toEqual(["openai"]);
  expect(calls).toHaveLength(0);
  modes.openrouter = "auth";

  try {
    await run();

    throw new Error("Expected all reviewers unavailable");
  } catch (error) {
    expect((error as ReviewChainError).attempts).toHaveLength(2);
  }

});

test("timeout uses only the configured fallback and ignores late results", async () => {
  modes.openai = "timeout";

  const result = await run({ ...config, requestTimeoutMs: 5 });

  expect(result.selectedReviewer).toEqual(fallback);
  expect(result.attempts[0].reason).toContain("timed out");
  await new Promise((done) => setTimeout(done, 40));
  expect(result.selectedReviewer).toEqual(fallback);
  expect(calls).toHaveLength(2);
  expect(finishes).toBe(2);
});

test("cancellation prevents fallback before and during review", async () => {
  const cancelled = new AbortController();

  cancelled.abort();
  await expect(run(config, cancelled.signal)).rejects.toThrow();
  expect(calls).toHaveLength(0);

  const controller = new AbortController();

  onResponse = () => controller.abort();
  await expect(run(config, controller.signal)).rejects.toThrow();
  expect(calls).toHaveLength(1);
  expect(attempts).toHaveLength(0);
});

test("failed fallback audit callbacks abort the chain", async () => {
  modes.openai = "auth";
  await expect(
    run(config, undefined, {
      ...observer,
      failed() {
        throw new Error("Audit unavailable");
      },

    }),
  ).rejects.toThrow("Audit unavailable");
  expect(starts).toEqual(["openai"]);
  expect(calls).toHaveLength(0);
});

test("each new action starts at the highest priority, with no cached route", async () => {
  modes.openai = "auth";
  expect((await run()).selectedReviewer).toEqual(fallback);
  modes.openai = "approve";
  expect((await run()).selectedReviewer).toEqual(primary);
  expect(starts).toEqual(["openai", "openrouter", "openai"]);
});

test("the same action uses the same review policy regardless of coordination and valid denials stay final", async () => {
  const fixture = multiplexReviewFixtures[1];
  const gate: any = {
    ...registry,
    streamSimple: (model: any, context: any) => {
      calls.push({ model, context });

      const data = JSON.parse(context.messages[0].content);

      return {
        result: async () => ({
          ...message(model.provider),
          content: [
            {
              type: "text",
              text: JSON.stringify({
                requestId: data.requestId,
                decision: "deny",
                reason: "A concrete material concern remains.",
              }),
            },
          ],
        }),
      };
    },

  };

  for (const entries of [
    fixture.entries.filter(
      (entry) => entry.type === "message" || entry.customType === "auto-approval-review",
    ),
    fixture.entries,
  ]) {
    const review = buildReview(fixture.action, entries, config, "/project", [], {
      workspace: "/project",
    });
    const checked = await reviewWithFallback(config, gate, review, observer);

    expect(checked.verdict.decision).toBe("deny");
    expect(checked.selectedReviewer).toEqual(primary);
  }

  expect(calls).toHaveLength(2);
  expect(calls[0].context.systemPrompt).toEqual(calls[1].context.systemPrompt);
  expect(calls[0].context.systemPrompt).toContain(
    "The executable operation is action.tool with action.arguments",
  );
  expect(calls[0].context.systemPrompt).toContain("alternative unreviewed execution routes");

  for (const call of calls) {
    const data = JSON.parse(call.context.messages[0].content);

    expect(data.action).toEqual(fixture.action);
    expect(data.runtimeContext).toBeUndefined();
    expect(data.previousDenials[0].reason).toContain("assigns a worker");
  }

});

test("coded token expiry is retried before fallback, while a delivered denial remains binding", async () => {
  modes[primary.provider] = "expired";
  modes[fallback.provider] = "approve";
  onResponse = () => {
    if (calls.length === 2) modes[primary.provider] = "approve";

  };

  const recovered = await run();

  expect(recovered.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(2);
  expect(clock).toBe(3000);
  expect(calls[0].context).toEqual(calls[1].context);

  calls = [];
  onResponse = undefined;
  modes[primary.provider] = "expired_deny";

  const denied = await run();

  expect(denied.verdict.decision).toBe("deny");
  expect(denied.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(1);
});

test("exhausted token-expiry retries allow only configured fallback and never label the response as confirmed bad credentials", async () => {
  modes[primary.provider] = "expired";
  modes[fallback.provider] = "approve";

  const result = await run();

  expect(result.selectedReviewer).toEqual(fallback);
  expect(calls.filter((call) => call.model.provider === primary.provider)).toHaveLength(6);
  expect(clock).toBe(15000);
  expect(result.attempts[0].reason).toContain("temporarily unavailable");
  expect(result.attempts[0].reason).not.toContain("/login");
});

