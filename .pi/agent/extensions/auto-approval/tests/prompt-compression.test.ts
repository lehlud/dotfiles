import { beforeEach, afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preparePromptContext } from "../../shared/review/compression.ts";
import { buildReview } from "../review.ts";
import { type Config } from "../../shared/configuration/schemas.ts";
import { readPromptOriginal } from "../../shared/review/originals.ts";
import { reviewWithFallback } from "../review.ts";
import { ReviewChainError } from "../../shared/review/client.ts";
import { OPERATOR_INPUT_ENTRY } from "../../shared/contracts/operator-input.ts";
import { promptDigest } from "../../shared/review/prompts.ts";

const root = await mkdtemp(join(tmpdir(), "pi-prompt-compression-"));
const config: Config = {
  reviewers: [
    { provider: "fixture", model: "small", thinking: "off" },
    { provider: "fallback", model: "small", thinking: "off" },
  ],
  recentUserPrompts: 6,
  requestTimeoutMs: 5000,
  sandbox: { backend: "bwrap", executable: "/usr/bin/bwrap", runnerExecutable: "/executor" },
};
const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0.01, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.012 },
};
let calls: any[],
  saved: any[],
  mode: "approve" | "deny" | "invalid",
  missing: boolean,
  sequence: number;

beforeEach(() => {
  calls = [];
  saved = [];
  mode = "approve";
  missing = false;
  sequence = 0;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const registry: any = {
  find: (provider: string, id: string) =>
    missing && provider === "fixture"
      ? undefined
      : { provider, id, reasoning: false, contextWindow: 272000, maxTokens: 4096 },
  hasConfiguredAuth: () => true,
  streamSimple(model: any, context: any) {
    calls.push({ model, context });

    const data = JSON.parse(context.messages[0].content);

    return {
      result: async () => ({
        role: "assistant",
        stopReason: "stop",
        usage,
        content: [
          {
            type: "text",
            text:
              mode === "invalid"
                ? "bad JSON"
                : JSON.stringify({
                    requestId: data.requestId,
                    decision: mode === "deny" ? "deny" : "approve",
                    reason:
                      mode === "deny"
                        ? "Die Bedingungen passen nicht verlustfrei in die Zusammenfassung."
                        : "Quelltext prüfen. Keine Referenz ändern oder Zugangsdaten lesen. Testbericht als Beleg verwenden.",
                  }),
          },
        ],
      }),
    };
  },
};
const branch = (text: string) => [{ type: "message", message: { role: "user", content: text } }];
const observer = { saved: (record: any) => saved.push(record) };
const proposed = {
  tool: "read",
  arguments: { path: "reference.c" },
  goal: "Prüfen",
  justification: "Fehler verstehen",
};
const original =
  "Quelltext prüfen. Keine Referenz ändern und keine Zugangsdaten lesen.\n" +
  "Testdaten ".repeat(2000);

test("recorded task frames keep compressed anchors and old restrictions beyond the recent window", async () => {
  const prompts = [
    original,
    "Do not upload source or change public API contracts.",
    "Refactor the Dart code for readability.",
  ];
  const entries = prompts.flatMap((text, index) => [
    { id: `user-${index}`, type: "message", message: { role: "user", content: text } },
    {
      type: "custom",
      customType: OPERATOR_INPUT_ENTRY,
      data: {
        messageId: `user-${index}`,
        promptId: promptDigest(text),
        kind: index ? "steering" : "task",
        taskEntryId: "user-0",
      },
    },
  ]);
  const narrow = { ...config, recentUserPrompts: 1 };
  const prepared = await preparePromptContext(entries, narrow, registry, join(root, "task-frame"));

  expect(prepared.records.map((record) => record.original)).toEqual(prompts);
  expect(prepared.records[0].compressed).toBe(true);

  const envelope = buildReview(
    proposed,
    entries,
    narrow,
    "/project",
    [],
    undefined,
    undefined,
    prepared,
  );
  const data = JSON.parse(envelope.text);

  expect(data.taskContext.taskPromptIndex).toBe(0);
  expect(data.userPromptInfo.map((record: any) => record.inputKind)).toEqual([
    "task",
    "steering",
    "steering",
  ]);
  expect(data.userPromptInfo.map((record: any) => record.isSteering)).toEqual([false, true, true]);
  expect(envelope.promptSources?.get(prepared.records[0].promptId)).toBe(original);
  expect(data.userPrompts[1]).toContain("Do not upload source");
  expect(data.latestUserPrompt).toBe(prompts[2]);
});

test("legacy raw prompts compress on demand, persist privately and reuse across instances", async () => {
  const agent = join(root, "reuse");
  const entries = branch(original);
  const first = await preparePromptContext(entries, config, registry, agent, observer);

  expect(first.records[0].compressed).toBe(true);
  expect(first.records[0].original).toBe(original);
  expect(entries[0].message.content).toBe(original);
  expect(saved[0].original).toBeUndefined();

  const cache = join(agent, "cache", "approval-prompts");

  expect((await stat(cache)).mode & 0o077).toBe(0);
  expect((await stat(join(cache, (await readdir(cache))[0]))).mode & 0o077).toBe(0);

  const count = calls.length;
  const second = await preparePromptContext(
    structuredClone(entries),
    config,
    registry,
    agent,
    observer,
  );

  expect(second.records[0].cacheHit).toBe(true);
  expect(calls).toHaveLength(count);
  expect(second.usage).toBeUndefined();
  expect(first.usage?.totalTokens).toBe(12);

  const persisted = {
    type: "custom",
    customType: "auto-approval-prompt-compression",
    data: saved[0],
  };
  const restored = await preparePromptContext(
    [...entries, persisted],
    config,
    registry,
    join(root, "restored"),
  );

  expect(restored.records[0].cacheHit).toBe(true);
  expect(calls).toHaveLength(count);

  const review = buildReview(
    proposed,
    entries,
    config,
    "/project",
    [],
    undefined,
    undefined,
    second,
  );

  expect(JSON.parse(review.text).userPromptInfo[0].compressed).toBe(true);
  expect(
    readPromptOriginal(review.promptSources, {
      promptId: second.records[0].promptId,
      operation: "head",
      limit: 100,
    }).excerpts[0].text,
  ).toContain("Keine Referenz");
  await preparePromptContext(branch(original + " Neue Bedingung."), config, registry, agent);
  expect(calls.length).toBeGreaterThan(count);
});

test("every short prompt is marked original and no compression model is called", async () => {
  const entries = branch("Nur die Datei lesen.");
  const prepared = await preparePromptContext(entries, config, registry, join(root, "short"));
  const data = JSON.parse(
    buildReview(proposed, entries, config, "/project", [], undefined, undefined, prepared).text,
  );

  expect(data.userPrompts).toEqual(["Nur die Datei lesen."]);
  expect(data.userPromptInfo[0].compressed).toBe(false);
  expect(calls).toHaveLength(0);
  expect(() =>
    buildReview(
      proposed,
      branch("Anderer Auftrag"),
      config,
      "/project",
      [],
      undefined,
      undefined,
      prepared,
    ),
  ).toThrow("actual operator branch");
});

test("chunked compression stays bounded and sums usage, denial preserves raw intent without fallback", async () => {
  const text = original.repeat(5);
  const prepared = await preparePromptContext(branch(text), config, registry, join(root, "chunks"));

  expect(prepared.records[0].compressed).toBe(true);
  expect(calls).toHaveLength(3);
  expect(prepared.usage?.totalTokens).toBe(36);
  mode = "deny";
  calls = [];

  const denied = await preparePromptContext(
    branch(original),
    config,
    registry,
    join(root, "denied"),
  );

  expect(denied.records[0].compressed).toBe(false);
  expect(denied.records[0].text).toBe(original);
  expect(calls).toHaveLength(1);
  expect(calls[0].model.provider).toBe("fixture");
});

test("provider absence permits fallback, malformed summaries and cancellation never do", async () => {
  missing = true;
  await preparePromptContext(branch(original), config, registry, join(root, "fallback"));
  expect(calls[0].model.provider).toBe("fallback");
  missing = false;
  mode = "invalid";
  calls = [];
  await expect(
    preparePromptContext(branch(original), config, registry, join(root, "invalid")),
  ).rejects.toBeInstanceOf(ReviewChainError);
  expect(calls).toHaveLength(1);

  const cancelled = new AbortController();

  cancelled.abort();
  calls = [];
  await expect(
    preparePromptContext(
      branch(original),
      config,
      registry,
      join(root, "cancelled"),
      {},
      cancelled.signal,
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test("original lookups stay within selected IDs and bounded text, including a huge JSON line", () => {
  const id = "a".repeat(64),
    sources = new Map([[id, "Anfang\n" + "x".repeat(50000) + "Keine Referenz ändern.\nEnde"]]);

  expect(
    readPromptOriginal(sources, { promptId: id, operation: "head", limit: 6 }).excerpts[0].text,
  ).toBe("Anfang");
  expect(
    readPromptOriginal(sources, { promptId: id, operation: "tail", limit: 4 }).excerpts[0].text,
  ).toBe("Ende");

  const grep = readPromptOriginal(sources, {
    promptId: id,
    operation: "grep",
    query: "Keine Referenz",
    limit: 1000,
  });

  expect(grep.excerpts[0].text).toContain("Keine Referenz");
  expect(grep.excerpts[0].text.length).toBeLessThanOrEqual(1000);
  expect(
    readPromptOriginal(sources, {
      promptId: id,
      operation: "read",
      offset: grep.excerpts[0].offset,
      limit: 1000,
    }).excerpts[0].text,
  ).toBe(grep.excerpts[0].text);
  expect(() =>
    readPromptOriginal(sources, { promptId: "b".repeat(64), operation: "head" }),
  ).toThrow("selected branch");
  expect(() =>
    readPromptOriginal(sources, {
      promptId: id,
      operation: "grep",
      query: "x",
      path: "/etc/passwd",
    }),
  ).toThrow("Invalid");
  expect(() =>
    readPromptOriginal(sources, { promptId: id, operation: "read", limit: 8001 }),
  ).toThrow("Invalid");
});

test("reviewer can discover an omitted prohibition in the original and deny without fallback", async () => {
  const prepared = await preparePromptContext(
    branch(original),
    config,
    registry,
    join(root, "review"),
  );

  prepared.records[0].text = "Testbericht prüfen.";

  const envelope = buildReview(
    proposed,
    branch(original),
    config,
    "/project",
    [],
    undefined,
    undefined,
    prepared,
  );
  const gate: any = {
    ...registry,
    streamSimple(model: any, context: any) {
      calls.push({ model, context });
      sequence++;

      const content =
        sequence === 1
          ? [
              {
                type: "toolCall",
                id: "lookup",
                name: "prompt_original",
                arguments: {
                  promptId: prepared.records[0].promptId,
                  operation: "grep",
                  query: "Keine Referenz",
                },
              },
            ]
          : [
              {
                type: "text",
                text: JSON.stringify({
                  requestId: envelope.requestId,
                  decision: "deny",
                  reason: "Referenzänderungen sind im Original untersagt.",
                }),
              },
            ];

      return {
        result: async () => ({
          role: "assistant",
          stopReason: sequence === 1 ? "toolUse" : "stop",
          usage,
          content,
        }),
      };
    },
  };

  calls = [];

  const result = await reviewWithFallback(config, gate, envelope, {
    start() {},

    finish() {},

    failed() {},
  });

  expect(result.verdict.decision).toBe("deny");
  expect(calls).toHaveLength(2);
  expect(calls[1].context.messages.at(-1).content[0].text).toContain("Keine Referenz");
  expect(result.usage?.totalTokens).toBe(36);
  expect(result.promptLookups).toHaveLength(1);
});

test("approval without original inspection and arbitrary reviewer tools fail without fallback", async () => {
  const prepared = await preparePromptContext(
    branch(original),
    config,
    registry,
    join(root, "no-bypass"),
  );
  const envelope = buildReview(
    proposed,
    branch(original),
    config,
    "/project",
    [],
    undefined,
    undefined,
    prepared,
  );

  calls = [];
  await expect(
    reviewWithFallback(config, registry, envelope, { start() {}, finish() {}, failed() {} }),
  ).rejects.toThrow("inspect every compressed original");
  expect(calls).toHaveLength(1);

  const hostile: any = {
    ...registry,
    streamSimple() {
      return {
        result: async () => ({
          role: "assistant",
          stopReason: "toolUse",
          usage,
          content: [
            {
              type: "toolCall",
              id: "attack",
              name: "bash",
              arguments: { command: "touch forbidden" },
            },
          ],
        }),
      };
    },
  };

  await expect(
    reviewWithFallback(config, hostile, envelope, { start() {}, finish() {}, failed() {} }),
  ).rejects.toThrow("no fallback");
});

test("ten compressed prompts are eager and all ten originals can be checked before approval", async () => {
  const entries = Array.from(
    { length: 10 },
    (_, index) => branch(`Actual operator prompt ${index}. ${original}`)[0],
  );
  const prepared = await preparePromptContext(entries, config, registry, join(root, "ten-prompts"));
  const envelope = buildReview(
    proposed,
    entries,
    config,
    "/project",
    [],
    undefined,
    undefined,
    prepared,
  );
  const contexts: any[] = [];
  const gate: any = {
    ...registry,
    streamSimple(_model: any, context: any) {
      contexts.push(context);

      const content =
        contexts.length === 1
          ? prepared.records.map((record, index) => ({
              type: "toolCall",
              id: `original-${index}`,
              name: "prompt_original",
              arguments: { promptId: record.promptId, operation: "head", limit: 200 },
            }))
          : [
              {
                type: "text",
                text: JSON.stringify({
                  requestId: envelope.requestId,
                  decision: "approve",
                  reason: "The bounded source read supports the requested review.",
                }),
              },
            ];

      return {
        result: async () => ({
          role: "assistant",
          stopReason: contexts.length === 1 ? "toolUse" : "stop",
          usage,
          content,
        }),
      };
    },
  };

  const result = await reviewWithFallback(config, gate, envelope, {
    start() {},

    finish() {},

    failed() {},
  });
  const eager = JSON.parse(contexts[0].messages[0].content);

  expect(eager.userPrompts).toHaveLength(10);
  expect(eager.userPrompts).toEqual(prepared.records.map((record) => record.text));
  expect(eager.userPromptInfo.every((info: any) => info.compressed)).toBe(true);
  expect(contexts[0].messages).toHaveLength(1);
  expect(contexts).toHaveLength(2);
  expect(result.verdict.decision).toBe("approve");
  expect(result.promptLookups).toHaveLength(10);
});

test("private cache cannot follow planted symlinks outside protected agent storage", async () => {
  const agent = join(root, "unsafe"),
    elsewhere = join(root, "elsewhere");

  await mkdir(agent);
  await mkdir(elsewhere);
  await symlink(elsewhere, join(agent, "cache"));
  await expect(preparePromptContext(branch(original), config, registry, agent)).rejects.toThrow(
    "escapes",
  );
  expect(calls).toHaveLength(0);
});

test("a malformed private cache is regenerated without changing the original prompt", async () => {
  const agent = join(root, "corrupt"),
    entries = branch(original);
  const prepared = await preparePromptContext(entries, config, registry, agent);

  await writeFile(
    join(agent, "cache", "approval-prompts", `${prepared.records[0].cacheKey}.json`),
    "{bad JSON",
    { mode: 0o600 },
  );
  calls = [];

  const replacement = await preparePromptContext(entries, config, registry, agent);

  expect(replacement.records[0].cacheHit).toBe(false);
  expect(calls).toHaveLength(1);
  expect(replacement.records[0].original).toBe(original);
});

test("compression and review retain the same active-goal history beyond ten refinements", async () => {
  const goal = "Implement full Flutter/Webapp parity";
  const entries = [
    { type: "custom", customType: "auto-approval-operator-prompt", data: { text: goal } },
    { type: "message", message: { role: "user", content: "Never upload project source." } },
    ...Array.from({ length: 12 }, (_, index) => ({
      type: "message",
      message: { role: "user", content: `Refinement ${index}` },
    })),
  ];
  const prepared = await preparePromptContext(
    entries,
    config,
    registry,
    join(root, "goal-history"),
    {},
    undefined,
    goal,
  );
  const envelope = buildReview(
    proposed,
    entries,
    config,
    "/project",
    [],
    undefined,
    goal,
    prepared,
  );
  const data = JSON.parse(envelope.text);

  expect(prepared.records).toHaveLength(14);
  expect(data.userPrompts).toHaveLength(14);
  expect(data.userPrompts).toContain("Never upload project source.");
  expect(calls).toHaveLength(0);
});
