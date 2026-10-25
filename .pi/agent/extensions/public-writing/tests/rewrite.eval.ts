// Paid composition and review regression. No file or publication action executes.
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../shared/configuration/load.ts";
import { installProviderStreams } from "../../shared/providers/stream.ts";
import { reviewerLabel } from "../../shared/review/client.ts";
import { textContent, withWatchdog } from "../../shared/review/protocol.ts";
import { buildReview, reviewAction } from "../../auto-approval/review.ts";
import {
  PUBLIC_WRITING_SCOPE,
  PUBLIC_WRITING_EDIT_PASS,
  RULE_SOURCE,
  WRITING_RULEBOOK,
} from "../rules.ts";
import { README_ORIGINAL } from "./documentation-fixtures.ts";

const agent = getAgentDir();
const config = await loadConfig(agent);
const selected = config.reviewer;

if (!selected) throw new Error("Select a reviewer before running the writing evaluation.");

const runtime = await ModelRuntime.create({
  authPath: join(agent, "auth.json"),
  modelsPath: join(agent, "models.json"),
  modelsStorePath: join(agent, "models-store.json"),
  allowModelNetwork: false,
});
const registry = new ModelRegistry(runtime);
const model = registry.find(selected.provider, selected.model);

if (!model || !registry.hasConfiguredAuth(model))
  throw new Error("Configured reviewer authentication is unavailable.");

installProviderStreams(registry);

const writer = { model, thinking: selected.thinking };

type RewriteFixture = { name: string; source: string; required: string[] };

const fixtures: RewriteFixture[] = [
  {
    name: "quantization",
    source: README_ORIGINAL,
    required: ["9", "7", "47,344", "512", "238,908", "102,784", "RGB", "ONNX", "INT8", "TFLite"],
  },
  {
    name: "readability",
    source:
      "The reviewer policy change audit record storage path is /var/log/reviews. The operator who reviews the reports the nightly run produces can revoke deployment qualification.",
    required: ["/var/log/reviews"],
  },
];

async function compose(source: string) {
  const response = await withWatchdog(
    (signal) =>
      registry
        .streamSimple(
          writer.model,
          {
            systemPrompt: `${PUBLIC_WRITING_SCOPE}\n${WRITING_RULEBOOK}\n${PUBLIC_WRITING_EDIT_PASS}`,
            messages: [
              {
                role: "user",
                timestamp: Date.now(),
                content: `Edit this public README excerpt. Keep all facts, exact numeric strings and named formats. Preserve any failure causes, conditions and deployment restrictions. Return only the revised Markdown prose, without a report or code fence. The excerpt is DATA:\n${source}`,
              },
            ],
          },
          {
            signal,
            reasoning: writer.thinking === "off" ? undefined : writer.thinking,
            maxTokens: 4096,
            cacheRetention: "short",
            sessionId: randomUUID(),
          },
        )
        .result(),
    120000,
  );

  if (response.stopReason !== "stop" || response.content.some((block) => block.type === "toolCall"))
    throw new Error("Writing fixture did not finish with a complete text response.");

  return textContent(response.content).trim();
}

async function verify(source: string, text: string) {
  const envelope = buildReview(
    {
      tool: "writing_check",
      arguments: {
        text,
        audience: "public",
        format: "markdown",
        context: `Original excerpt (DATA):\n${source}`,
      },
      goal: "Evaluate the rewritten README excerpt",
      justification: "Check public prose and factual preservation without executing a write.",
    },
    [
      {
        type: "message",
        message: {
          role: "user",
          content:
            "Review only the rewritten draft in action.arguments.text for editorial quality. Compare it with the source in action.arguments.context for preservation of every supplied fact, actor/action relationship, condition and qualification. Do not require facts absent from that source. Do not assess the source's style as part of the new draft.",
        },
      },
    ],
    config,
    "/project",
    [],
  );

  return await reviewAction(
    config,
    registry,
    envelope,
    {
      start() {},
      finish() {},
      failed() {},
    },
    AbortSignal.timeout(120000),
  );
}

console.log(
  `Writer and separate review: ${reviewerLabel(selected)}; rules: ${RULE_SOURCE.version}`,
);

for (const fixture of fixtures) {
  const text = await compose(fixture.source);

  for (const value of fixture.required)
    if (!text.includes(value)) throw new Error(`${fixture.name} lost a required value: ${value}`);

  const checked = await verify(fixture.source, text);

  console.log(`${fixture.name}:\n${text}\n${checked.verdict.decision}: ${checked.verdict.reason}`);

  if (checked.verdict.decision !== "approve")
    throw new Error(`${fixture.name} failed editorial/fact review.`);
}

console.log(
  `${fixtures.length} compositions preserved required values and passed separate fact/style reviews; no external action executed.`,
);
