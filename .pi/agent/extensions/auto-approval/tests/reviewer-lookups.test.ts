import { expect, test } from "bun:test";
import { buildReview, reviewWithFallback } from "../review.ts";
import { readPromptOriginal, type PromptLookup } from "../../shared/review/originals.ts";
import { promptDigest } from "../../shared/review/prompts.ts";
import type { Request } from "../../shared/contracts/action.ts";
import type { Config } from "../../shared/configuration/schemas.ts";

const config: Config = {
  reviewers: [
    { provider: "primary", model: "fixture", thinking: "off" },
    { provider: "fallback", model: "fixture", thinking: "off" },
  ],
  recentUserPrompts: 10,
  requestTimeoutMs: 5000,
  sandbox: { backend: "bwrap", executable: "/bwrap", runnerExecutable: "/runner" },
};
const original =
  "Fetch the client dependencies and build the Flutter web client. Use separately reviewed networking for downloads. Never read credentials or upload project files.\n" +
  "Diagnostic log line.\n".repeat(1500);
const promptId = promptDigest(original);
const valid: PromptLookup = { promptId, operation: "head", limit: 200 };
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixture(command = "flutter build web --no-pub") {
  const action: Request = {
    tool: "bash",
    arguments: { command },
    sandbox: { tools: [command.startsWith("dart") ? "dart" : "flutter"] },
    network: command.includes("pub get"),
    goal: "Prepare and build the client",
    justification: "Run the requested project workflow in its prepared container sandbox.",
  };
  const envelope = buildReview(
    action,
    [{ type: "message", message: { role: "user", content: original } }],
    config,
    "/project",
    [],
    undefined,
    undefined,
    {
      records: [
        {
          promptId,
          original,
          text: "Fetch dependencies and build Flutter web. Downloads need separate network approval. Never read credentials or upload project files.",
          compressed: true,
          originalBytes: Buffer.byteLength(original),
          version: 1,
          cacheHit: true,
        },
      ],
    },
  );

  return { action, envelope };
}

const lookup = (args: unknown, name = "prompt_original") => ({
  type: "toolCall",
  id: "original-lookup",
  name,
  arguments: args,
});

function gate(
  envelope: ReturnType<typeof fixture>["envelope"],
  script: (turn: number) => unknown[],
) {
  const calls: any[] = [];
  const registry: any = {
    find: (provider: string, id: string) => ({
      provider,
      id,
      reasoning: false,
      contextWindow: 272000,
      maxTokens: 4096,
    }),
    hasConfiguredAuth: () => true,
    streamSimple(model: any, context: any) {
      calls.push({ model, context });

      const content = script(calls.length);

      return {
        result: async () => ({
          role: "assistant",
          usage,
          content,
          stopReason: content.some((item: any) => item.type === "toolCall") ? "toolUse" : "stop",
        }),
      };
    },
  };
  const verdict = (decision = "approve") => [
    {
      type: "text",
      text: JSON.stringify({
        requestId: envelope.requestId,
        decision,
        reason: "Bounded fixture verdict.",
      }),
    },
  ];

  return { calls, registry, verdict };
}

const observer = { start() {}, finish() {}, failed() {} };

test("argument normalization cannot add paths, replace required fields or broaden original selection", () => {
  const sources = new Map([[promptId, original]]);

  for (const args of [
    JSON.stringify({ ...valid, path: "/etc/passwd" }),
    JSON.stringify({ ...valid, promptId: null }),
    JSON.stringify([valid]),
    " ".repeat(8193),
  ]) {
    expect(() => readPromptOriginal(sources, args)).toThrow("Invalid original-prompt lookup");
  }

  expect(() =>
    readPromptOriginal(sources, JSON.stringify({ ...valid, promptId: "0".repeat(64) })),
  ).toThrow("selected branch context");
});

test("cancellation during error feedback prevents another reviewer request", async () => {
  const { envelope } = fixture();
  const review = gate(envelope, () => [lookup({})]);
  const controller = new AbortController();

  await expect(
    reviewWithFallback(
      config,
      review.registry,
      envelope,
      {
        ...observer,
        lookupFailed: () => controller.abort(),
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(review.calls).toHaveLength(1);
});

test.each([JSON.stringify(valid), { ...valid, offset: null, query: null }])(
  "original reads accept equivalent provider argument encodings (%j)",
  (args) => {
    const result = readPromptOriginal(new Map([[promptId, original]]), args);

    expect(result.excerpts[0].text).toBe(original.slice(0, 200));
  },
);

test.each([
  ["flutter pub get", { ...valid, limit: 20000 }],
  ["dart pub get", { ...valid, promptId: "0".repeat(64) }],
  ["flutter build web --no-pub", { ...valid, offset: original.length + 1, operation: "read" }],
])("the same reviewer repairs a lookup before approving %s", async (command, malformed) => {
  const { action, envelope } = fixture(command as string);
  const review = gate(envelope, (turn) =>
    turn === 1 ? [lookup(malformed)] : turn === 2 ? [lookup(valid)] : review.verdict(),
  );
  const failures: unknown[] = [];
  const result = await reviewWithFallback(config, review.registry, envelope, {
    ...observer,
    lookupFailed: (failure: unknown) => failures.push(failure),
  });

  expect(result.verdict.decision).toBe("approve");
  expect(review.calls).toHaveLength(3);
  expect(review.calls.every((call) => call.model.provider === "primary")).toBe(true);
  expect(JSON.parse(review.calls[1].context.messages.at(-1).content[0].text).error).toBeDefined();
  expect(review.calls[1].context.messages.at(-1).isError).toBe(true);
  expect(failures).toHaveLength(1);
  expect(result.promptLookups).toEqual([valid]);

  for (const call of review.calls) {
    expect(JSON.parse(call.context.messages[0].content).action).toEqual(action);
  }
});

test("three bad original lookups stop with a specific safe diagnostic and no fallback", async () => {
  const { envelope } = fixture();
  const review = gate(envelope, () => [lookup({ ...valid, path: "synthetic-private-input" })]);

  await expect(reviewWithFallback(config, review.registry, envelope, observer)).rejects.toThrow(
    "invalid-arguments",
  );
  expect(review.calls).toHaveLength(3);
  expect(review.calls.every((call) => call.model.provider === "primary")).toBe(true);
  expect(JSON.stringify(review.calls.at(-1).context.messages.at(-1))).not.toContain(
    "synthetic-private-input",
  );
});

test("a denial stays final even when it accompanies a malformed original lookup", async () => {
  const { envelope } = fixture();
  const review = gate(envelope, () => [...review.verdict("deny"), lookup({})]);
  const result = await reviewWithFallback(config, review.registry, envelope, observer);

  expect(result.verdict.decision).toBe("deny");
  expect(review.calls).toHaveLength(1);
});

test("repair never supplies original-inspection credit or permission for other tools", async () => {
  const { envelope } = fixture();
  const review = gate(envelope, (turn) => (turn === 1 ? [lookup({})] : review.verdict()));

  await expect(reviewWithFallback(config, review.registry, envelope, observer)).rejects.toThrow(
    "inspect every compressed original",
  );
  expect(review.calls).toHaveLength(2);

  const hostile = gate(envelope, () => [lookup({ command: "touch forbidden" }, "bash")]);

  await expect(reviewWithFallback(config, hostile.registry, envelope, observer)).rejects.toThrow(
    "unsupported tool",
  );
  expect(hostile.calls).toHaveLength(1);
});

test.each(["lookup", "lookupFailed"])(
  "a failed %s audit blocks repair, execution and fallback",
  async (callback) => {
    const { envelope } = fixture();
    const review = gate(envelope, () => [lookup(callback === "lookup" ? valid : {})]);

    await expect(
      reviewWithFallback(config, review.registry, envelope, {
        ...observer,
        [callback]: () => {
          throw new Error("synthetic-private-audit-error");
        },
      }),
    ).rejects.toThrow("lookup audit failed");
    expect(review.calls).toHaveLength(1);
  },
);
