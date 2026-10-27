import { test, expect, beforeEach } from "bun:test";
import { reviewAction } from "../review.ts";
import { ReviewError, type ReviewAttempt } from "../../shared/review/client.ts";
import { buildReview } from "../review.ts";
import { type Config } from "../../shared/configuration/schemas.ts";
import { multiplexReviewFixtures } from "./multiplex-review-fixtures.ts";
import { ProviderAvailability } from "../../shared/providers/availability.ts";
import { expiredTokenResponse } from "./provider-error-fixtures.ts";
import { steeringReviewFixtures } from "./steering-review-fixtures.ts";
import { taskContinuationReviewFixtures } from "./task-continuation-review-fixtures.ts";
import { denialReviewFixtures } from "./denial-review-fixtures.ts";
import { WRITING_RULEBOOK } from "../../public-writing/rules.ts";

const primary = { provider: "openai", model: "gpt-6-luna", thinking: "medium" as const };
const alternative = {
  provider: "openrouter",
  model: "openai/gpt-6-luna",
  thinking: "medium" as const,
};
const config: Config = {
  reviewer: primary,
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
  reviewAction(settings, registry, envelope, callbacks, signal, undefined, availability);

test("fast processing never retries a denial with another reviewer", async () => {
  modes.openai = "deny";

  const checked = await reviewAction(
    config,
    registry,
    envelope,
    observer,
    undefined,
    undefined,
    availability,
    { fastMode: () => true },
  );

  expect(checked.verdict.decision).toBe("deny");
  expect(calls).toHaveLength(1);
  expect(checked.selectedReviewer.provider).toBe("openai");
});

test("fast processing uses the selected reviewer's route without loosening routing pins", async () => {
  modes.openai = "auth";

  const gate = {
    ...registry,
    find(provider: string, id: string) {
      const model = registry.find(provider, id);

      return (
        model && { ...model, api: provider === "openrouter" ? "openai-completions" : model.api }
      );
    },
  };
  const checked = await reviewAction(
    { ...config, reviewer: alternative },
    gate,
    envelope,
    observer,
    undefined,
    undefined,
    availability,
    { fastMode: () => true },
  );
  const payload = calls[0].options.onPayload(
    {
      model: calls[0].model.id,
      provider: { only: ["trusted"], allow_fallbacks: false, data_collection: "deny" },
    },
    calls[0].model,
  );

  expect(checked.selectedReviewer.provider).toBe("openrouter");
  expect(calls).toHaveLength(1);
  expect(payload.provider).toEqual({
    only: ["trusted"],
    allow_fallbacks: false,
    data_collection: "deny",
    sort: "throughput",
  });
});

test("editorial rules apply to writing_check only, never ordinary file mutations", async () => {
  const actions = [
    { tool: "write", arguments: { path: "page.txt", content: "Not a tool. A revolution." } },
    {
      tool: "edit",
      arguments: { path: "page.txt", oldText: "Old title", newText: "Not a tool. A revolution." },
    },
    { tool: "bash", arguments: { command: "printf 'Not a tool. A revolution.' > page.txt" } },
    { tool: "writing_check", arguments: { text: "Not a tool. A revolution.", audience: "public" } },
  ];

  for (const action of actions) {
    const request = buildReview(
      {
        ...action,
        goal: "Implement the site",
        justification: "Bounded project work",
      },
      [{ type: "message", message: { role: "user", content: "Build the site." } }],
      config,
      "/project",
      [],
    );

    await reviewAction(config, registry, request, observer, undefined, undefined, availability);

    const policy = calls.at(-1).context.systemPrompt;

    expect(policy.includes(WRITING_RULEBOOK)).toBe(action.tool === "writing_check");
  }
});

test("provider receives current formatter separately from historical writes and renewed authorization", async () => {
  for (const fixture of denialReviewFixtures.slice(0, 2)) {
    const request = buildReview(
      fixture.action,
      fixture.entries,
      config,
      "/project",
      [],
      { backend: "bwrap" },
      fixture.operatorGoal,
    );

    await reviewAction(config, registry, request, observer, undefined, undefined, availability);

    const data = JSON.parse(calls.at(-1).context.messages[0].content);

    expect(data.operatorGoal).toBe(fixture.operatorGoal);
    expect(data.action.tool).toBe("bash");
    expect(data.action.arguments.command).toStartWith("dart format ");
    expect(Object.keys(data).slice(-3)).toEqual(["action", "sandboxPlan", "requestId"]);
    expect(data.previousDenials[0].source).toBe("historical-review-result");
    expect(data.previousDenials[0].matchesCurrentOperation).toBe(
      fixture === denialReviewFixtures[0],
    );

    if (fixture === denialReviewFixtures[0]) {
      expect(data.latestUserPrompt).toContain("Continue; you have permission");
      expect(data.previousDenials[0].laterOperatorPromptIds).toEqual([
        data.userPromptInfo.at(-1).promptId,
      ]);
    } else {
      expect(data.reviewedContext[0].tool).toBe("write");
      expect(data.reviewedContext[0].arguments.path).toContain("customer_related_error_test.dart");
    }
  }
});

test.each([0, 4])(
  "continuation retains the original goal and completed refinement for either delivery mode (case %i)",
  async (index) => {
    const fixture = taskContinuationReviewFixtures[index];
    const request = buildReview(fixture.action, fixture.entries, config, "/project", []);

    await reviewAction(config, registry, request, observer, undefined, undefined, availability);

    const data = JSON.parse(calls[0].context.messages[0].content);

    expect(data.userPrompts[0]).toContain("inventory browsing screen");
    expect(data.latestUserPrompt).toBe("Make User.nickname optional in the client model.");
    expect(data.userPromptInfo.map((info: any) => info.isSteering)).toEqual([false, index === 0]);
    expect(data.reviewedContext[0].arguments.path).toBe("lib/api/user.dart");
    expect(data.reviewedContext[0].content[0].text).toContain("Successfully replaced");
    expect(data.action.arguments.path).toBe("lib/features/inventory/inventory_screen.dart");
    expect(data.previousDenials[0].reason).toContain("does not advance the latest");
    expect(data.userPrompts).not.toContain(
      "The nullable-field refinement is finished. I am continuing the inventory screen migration.",
    );
  },
);

test("the first reviewer request eagerly carries ten legacy inputs and does not repeat only the latest correction", async () => {
  const fixture = steeringReviewFixtures[0];
  const request = buildReview(fixture.action, fixture.entries, config, "/project", []);

  await reviewAction(config, registry, request, observer, undefined, undefined, availability);

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

test("the selected reviewer preserves request-bound output", async () => {
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

  expect(payload.text.format.schema.properties.requestId).toEqual({ type: "string" });
});

test("missing auth, missing models and unsupported thinking fail without selecting alternatives", async () => {
  for (const mode of ["auth", "missing", "unsupported"] as const) {
    modes.openai = mode;
    await expect(run()).rejects.toThrow("Reviewer check failed");
  }

  expect(starts).toEqual(["openai", "openai", "openai"]);
  expect(calls).toHaveLength(0);
});

test("provider failures keep the selected reviewer through long recovery and redact failed-attempt details", async () => {
  modes.openai = "throw";
  onResponse = () => {
    if (calls.length === 13) modes.openai = "approve";
  };

  const checked = await run();

  expect(checked.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(13);
  expect(calls.every((item) => item.model.provider === "openai")).toBe(true);
  expect(JSON.stringify(checked)).not.toContain("synthetic-private-error-content");
});

test("failed responses retain billed usage without consulting another reviewer", async () => {
  modes.openai = "error";

  try {
    await run();

    throw new Error("Expected review failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewError);
    expect((error as ReviewError).usage).toEqual(usage);
    expect((error as ReviewError).attempts[0].status).toBe("failed");
  }

  expect(calls.map((item) => item.context.messages[0].content)).toEqual([envelope.text]);
});

test("a valid denial is binding", async () => {
  modes.openai = "deny";

  const result = await run();

  expect(result.verdict.decision).toBe("deny");
  expect(result.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(1);
  expect(attempts).toHaveLength(0);
});

test("capacity preflight fails before any model request without truncating user instructions", async () => {
  capacities.openai = 8000;
  await expect(run()).rejects.toThrow("operator context and action were not truncated");
  expect(calls).toHaveLength(0);

  const checked = await run({ ...config, reviewer: alternative });

  expect(checked.selectedReviewer).toEqual(alternative);
  expect(calls).toHaveLength(1);
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
  const result = await reviewAction(config, gate, large, observer);

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

test("truncated, refused or aborted model responses block execution", async () => {
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

test("malformed or mismatched verdicts fail closed", async () => {
  for (const mode of ["invalid", "mismatch"] as const) {
    modes.openai = mode;
    calls = [];

    try {
      await run();

      throw new Error("Expected invalid verdict rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewError);
      expect((error as ReviewError).attempts.at(-1)?.status).toBe("invalid");
    }

    expect(calls).toHaveLength(1);
  }
});

test("an unconfigured or unavailable reviewer fails closed and retains diagnostics", async () => {
  await expect(run({ ...config, reviewer: undefined })).rejects.toThrow("No reviewer selected");
  expect(starts).toEqual([]);
  modes.openai = "auth";

  try {
    await run();

    throw new Error("Expected reviewer unavailable");
  } catch (error) {
    expect((error as ReviewError).attempts).toHaveLength(1);
  }

  expect(starts).toEqual(["openai"]);
  expect(calls).toHaveLength(0);
});

test("timeout fails closed and ignores a late verdict without starting another model", async () => {
  modes.openai = "timeout";
  await expect(run({ ...config, requestTimeoutMs: 5 })).rejects.toThrow("timed out");
  await new Promise((done) => setTimeout(done, 40));
  expect(calls).toHaveLength(1);
  expect(finishes).toBe(1);
});

test("cancellation stops review before and during a request", async () => {
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

test("failed review audit callbacks abort execution", async () => {
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

test("a new action retains the selected model when its provider becomes available again", async () => {
  modes.openai = "auth";
  await expect(run()).rejects.toThrow("authentication");
  modes.openai = "approve";
  expect((await run()).selectedReviewer).toEqual(primary);
  expect(starts).toEqual(["openai", "openai"]);
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
    const checked = await reviewAction(config, gate, review, observer);

    expect(checked.verdict.decision).toBe("deny");
    expect(checked.selectedReviewer).toEqual(primary);
  }

  expect(calls).toHaveLength(2);
  expect(calls[0].context.systemPrompt).toEqual(calls[1].context.systemPrompt);
  expect(calls[0].context.systemPrompt).toContain(
    "Assess the exact action.tool, action.arguments and sandbox access",
  );
  expect(calls[0].context.systemPrompt).toContain("alternative unreviewed execution routes");

  for (const call of calls) {
    const data = JSON.parse(call.context.messages[0].content);

    expect(data.action).toEqual(fixture.action);
    expect(data.runtimeContext).toBeUndefined();
    expect(data.previousDenials[0].reason).toContain("assigns a worker");
  }
});

test("coded token expiry retries the same model while a delivered denial remains binding", async () => {
  modes[primary.provider] = "expired";
  modes[alternative.provider] = "approve";
  onResponse = () => {
    if (calls.length === 2) modes[primary.provider] = "approve";
  };

  const recovered = await run();

  expect(recovered.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(2);
  expect(clock).toBe(15000);
  expect(calls[0].context).toEqual(calls[1].context);

  calls = [];
  onResponse = undefined;
  modes[primary.provider] = "expired_deny";

  const denied = await run();

  expect(denied.verdict.decision).toBe("deny");
  expect(denied.selectedReviewer).toEqual(primary);
  expect(calls).toHaveLength(1);
});

test("persistent token expiry remains cancelable without selecting another model", async () => {
  modes[primary.provider] = "expired";

  const controller = new AbortController();

  onResponse = () => {
    if (calls.length === 14) controller.abort();
  };

  await expect(
    reviewAction(config, registry, envelope, observer, controller.signal, undefined, availability),
  ).rejects.toThrow(/abort|cancel/i);

  expect(calls).toHaveLength(14);
  expect(calls.every((call) => call.model.provider === primary.provider)).toBe(true);
  expect(clock).toBeGreaterThan(3 * 1800000);
});

test("review deadlines exclude provider backoff but still bound actual requests", async () => {
  modes.openai = "expired";
  onResponse = () => {
    if (calls.length === 2) modes.openai = "approve";
  };

  const availability = new ProviderAvailability({
    wait: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    },
  });
  const checked = await reviewAction(
    { ...config, requestTimeoutMs: 30 },
    registry,
    envelope,
    observer,
    undefined,
    undefined,
    availability,
  );

  expect(checked.verdict.decision).toBe("approve");
  expect(calls).toHaveLength(2);
});
