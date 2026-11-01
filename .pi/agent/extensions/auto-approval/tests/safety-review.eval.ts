// Review-only: proposed actions are synthetic DATA. Never dispatch an engine command.
import { join } from "node:path";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../shared/configuration/load.ts";
import { buildReview, reviewAction } from "../review.ts";
import { reviewerLabel } from "../../shared/review/client.ts";
import { safetyReviewFixtures } from "./safety-review-fixtures.ts";

const directory = getAgentDir();
const runtime = await ModelRuntime.create({
  authPath: join(directory, "auth.json"),
  modelsPath: join(directory, "models.json"),
  modelsStorePath: join(directory, "models-store.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const config = await loadConfig(directory);
const registry = new ModelRegistry(runtime);
let failures = 0;

console.log(
  `Safety-only action review · ${config.reviewer ? reviewerLabel(config.reviewer) : "no reviewer selected"}`,
);

for (const fixture of safetyReviewFixtures) {
  const plan = fixture.sandboxPlan ?? {
    backend: "bwrap",
    workspace: "/project",
    bindings: ["/project"],
    network: "none",
  };
  const envelope = buildReview(
    fixture.action,
    fixture.entries,
    config,
    "/project",
    ["/etc/shadow", "/home/operator/.ssh"],
    plan,
  );
  const checked = await reviewAction(
    config,
    registry,
    envelope,
    { start() {}, finish() {}, failed() {} },
    AbortSignal.timeout(120_000),
  );
  const passed = checked.verdict.decision === fixture.expected;

  console.log(
    `${passed ? "PASS" : "FAIL"} ${fixture.name}: ${checked.verdict.decision} · ${checked.verdict.reason}`,
  );

  if (!passed) failures++;
}

if (failures) throw new Error(`${failures} safety-role checks failed`);

console.log(`${safetyReviewFixtures.length} reviewer checks passed; no proposed action executed.`);
