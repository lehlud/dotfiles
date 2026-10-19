// Live cache measurements with synthetic evidence; no proposed action is executed.
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Context, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "../../shared/configuration/load.ts";
import { buildReview, reviewWithFallback } from "../review.ts";
import { ReviewChainError } from "../../shared/review/client.ts";
import type { ReviewEnvelope, Usage } from "../../shared/review/contracts.ts";

type Layout = "legacy" | "corrected";

type Measurement = Record<string, unknown> & { status: string };

const agent = getAgentDir();
const runtime = await ModelRuntime.create({
  authPath: join(agent, "auth.json"),
  modelsPath: join(agent, "models.json"),
  modelsStorePath: join(agent, "models-store.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const registry = new ModelRegistry(runtime);
const config = await loadConfig(agent);
const compareLegacy = process.argv.includes("--compare-legacy");
const runId = randomUUID();
const output = `/tmp/pi-review-cache-live-${runId}.json`;
const rows: Measurement[] = [];
const report = {
  runId,
  startedAt: new Date().toISOString(),
  proposedActionsExecuted: 0,
  comparison: "Legacy mode replays the pre-fix nonce placement, routing key and output schema.",
  rows,
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function envelope(index: number, layout: Layout): ReviewEnvelope {
  const prompt =
    "Inspect README.md, src/cache-fixture.ts and tests/cache-fixture.test.ts in this project. " +
    "Read only these three files. Do not change files, use the network, read credentials, " +
    "start processes or delegate work. Report what each file contains.";
  const path = ["README.md", "src/cache-fixture.ts", "tests/cache-fixture.test.ts"][index];
  const review = buildReview(
    {
      tool: "read",
      arguments: { path },
      goal: "Inspect the three requested project files",
      justification: "Read exactly one of the operator-requested files.",
    },
    [{ type: "message", message: { role: "user", content: prompt } }],
    config,
    `/project/cache-validation-${runId}`,
    ["/home/operator/.ssh"],
    { workspace: `/project/cache-validation-${runId}`, network: "none", backend: "bwrap" },
  );

  if (layout === "corrected") return review;

  const { requestId, ...data } = JSON.parse(review.text);

  return { ...review, text: JSON.stringify({ requestId, ...data }), cachePrefix: undefined };
}

function legacyPayload(payload: any, provider: string, requestId: string) {
  if (provider !== "openai") return payload;

  const schema = payload.text?.format?.schema ?? payload.response_format?.json_schema?.schema;

  if (schema?.properties?.requestId) schema.properties.requestId.enum = [requestId];

  return payload;
}

function measuredRegistry(layout: Layout, snapshot: ReviewEnvelope, wire: Record<string, unknown>) {
  return {
    find: registry.find.bind(registry),
    hasConfiguredAuth: registry.hasConfiguredAuth.bind(registry),
    getAll: registry.getAll.bind(registry),
    getProvider: registry.getProvider.bind(registry),
    streamSimple(
      model: Parameters<ModelRegistry["streamSimple"]>[0],
      context: Context,
      options?: ModelsSimpleStreamOptions,
    ) {
      const selected = {
        ...options,
        ...(layout === "legacy"
          ? { cacheRetention: "short" as const, sessionId: snapshot.requestId }
          : {}),
        onPayload: async (payload: unknown, providerModel: typeof model) => {
          let body: any = (await options?.onPayload?.(payload, providerModel)) ?? payload;

          if (layout === "legacy")
            body = legacyPayload(body, providerModel.provider, snapshot.requestId);

          wire.cacheKey = body.prompt_cache_key ?? selected.sessionId;
          wire.schemaHash = hash(body.text?.format ?? body.response_format ?? null);
          wire.cacheOptions = body.prompt_cache_options ?? null;
          wire.explicitBreakpoints = (body.input ?? [])
            .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
            .filter((block: any) => block.prompt_cache_breakpoint).length;

          return body;
        },
        onResponse: async (
          response: Parameters<NonNullable<ModelsSimpleStreamOptions["onResponse"]>>[0],
          providerModel: typeof model,
        ) => {
          wire.httpStatus = response.status;
          await options?.onResponse?.(response, providerModel);
        },
      };

      return registry.streamSimple(model, context, selected);
    },
  };
}

async function measure(reviewer: (typeof config.reviewers)[number], layout: Layout, index: number) {
  const snapshot = envelope(index, layout);
  const wire: Record<string, unknown> = {};
  const started = performance.now();
  const base = {
    provider: reviewer.provider,
    model: reviewer.model,
    layout,
    sample: index + 1,
    wire,
  };

  try {
    const result = await reviewWithFallback(
      { ...config, reviewers: [reviewer], requestTimeoutMs: 90000 },
      measuredRegistry(layout, snapshot, wire),
      snapshot,
      { start() {}, finish() {}, failed() {} },
      AbortSignal.timeout(95000),
    );
    const usage = result.usage!;
    const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;

    return {
      ...base,
      status: result.verdict.decision === "approve" ? "ok" : "unexpected-denial",
      requestIdMatched: result.verdict.requestId === snapshot.requestId,
      durationMs: Math.round(performance.now() - started),
      usage,
      cachedInputPercent: totalInput ? Math.round((10000 * usage.cacheRead) / totalInput) / 100 : 0,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      durationMs: Math.round(performance.now() - started),
      // The review client redacts transport failures; never print raw SDK errors or headers.
      reason: error instanceof ReviewChainError ? error.message : "Live evaluation failed",
    };
  }
}

console.log(JSON.stringify({ report: output, samplesPerLayout: 3, compareLegacy }));

for (const reviewer of config.reviewers) {
  const model = registry.find(reviewer.provider, reviewer.model);

  if (!model || !registry.hasConfiguredAuth(model)) {
    const skipped = { provider: reviewer.provider, model: reviewer.model, status: "unavailable" };

    rows.push(skipped);
    console.log(JSON.stringify(skipped));

    continue;
  }

  for (const layout of compareLegacy
    ? (["legacy", "corrected"] as const)
    : (["corrected"] as const)) {
    for (let index = 0; index < 3; index++) {
      const result = await measure(reviewer, layout, index);

      rows.push(result);
      await Bun.write(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(result));

      if (result.status !== "ok") break;

      await Bun.sleep(2000);
    }
  }
}

const checks = config.reviewers.map(({ provider, model }) => {
  const corrected = rows.filter(
    (row) => row.provider === provider && row.model === model && row.layout === "corrected",
  );
  const warmCacheRead = corrected
    .slice(1)
    .reduce((total, row) => total + ((row.usage as Usage | undefined)?.cacheRead ?? 0), 0);
  const keys = new Set(corrected.map((row) => (row.wire as Record<string, unknown>).cacheKey));
  const schemas = new Set(corrected.map((row) => (row.wire as Record<string, unknown>).schemaHash));
  const passed =
    corrected.length === 3 &&
    corrected.every((row) => row.status === "ok" && row.requestIdMatched) &&
    warmCacheRead > 0 &&
    keys.size === 1 &&
    schemas.size === 1;

  return {
    provider,
    model,
    passed,
    warmCacheRead,
    stableKey: keys.size === 1,
    stableSchema: schemas.size === 1,
  };
});

await Bun.write(
  output,
  JSON.stringify({ ...report, finishedAt: new Date().toISOString(), checks }, null, 2),
);

if (checks.some((check) => !check.passed) || rows.some((row) => row.status !== "ok"))
  process.exitCode = 1;

console.log(JSON.stringify({ report: output, checks }));
