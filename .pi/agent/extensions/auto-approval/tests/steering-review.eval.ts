// Real configured reviewers; synthetic context only. No proposed action runs.
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadConfig } from "../../shared/configuration/load.ts";
import { buildReview, reviewWithFallback } from "../review.ts";
import { reviewerLabel } from "../../shared/review/client.ts";
import { steeringReviewFixtures } from "./steering-review-fixtures.ts";
import { taskContinuationReviewFixtures } from "./task-continuation-review-fixtures.ts";

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
let failures = 0;

const fixtures = [...taskContinuationReviewFixtures, ...steeringReviewFixtures];

for (const fixture of fixtures) {
  const plan = {
    workspace: "/project",
    bindings: ["/project"],
    temporaryStorage: { path: "/tmp", private: true, lifetime: "Pi session" },
    backend: config.sandbox.backend ?? "docker",
  };
  const envelope = buildReview(
    fixture.action,
    fixture.entries,
    config,
    "/project",
    ["/home/operator/.ssh"],
    plan,
  );
  const checked = await reviewWithFallback(
    config,
    registry,
    envelope,
    { start() {}, finish() {}, failed() {} },
    AbortSignal.timeout(120000),
  );
  const passed = checked.verdict.decision === fixture.expected;

  console.log(
    `${passed ? "PASS" : "FAIL"} ${fixture.name}: ${checked.verdict.decision} · ${reviewerLabel(checked.selectedReviewer)} · ${checked.verdict.reason}`,
  );

  if (!passed) failures++;

}

if (failures) throw new Error(`${failures} steering review evaluations failed`);

console.log(`${fixtures.length} semantic cases passed; no proposed action executed.`);
