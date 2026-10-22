// Real configured reviewers with synthetic task context; no proposed action runs.
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadConfig } from "../../shared/configuration/load.ts";
import { buildReview } from "../review.ts";
import { reviewAction } from "../review.ts";
import { reviewerLabel } from "../../shared/review/client.ts";
import { multiplexReviewFixtures } from "./multiplex-review-fixtures.ts";

const agent = getAgentDir();
const runtime = await ModelRuntime.create({
  authPath: join(agent, "auth.json"),
  modelsPath: join(agent, "models.json"),
  modelsStorePath: join(agent, "models-store.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const registry = new ModelRegistry(runtime),
  config = await loadConfig(agent);
let failures = 0;

for (const fixture of multiplexReviewFixtures) {
  const plan = {
    workspace: "/project",
    bindings: ["/project"],
    temporaryStorage: { path: "/tmp", private: true, lifetime: "Pi session" },
    requested: fixture.action.sandbox ?? {},
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
  const checked = await reviewAction(
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

if (failures) throw new Error(`${failures} multiplex review evaluations failed`);

console.log(
  `${multiplexReviewFixtures.length} semantic cases passed; no proposed action was executed.`,
);
