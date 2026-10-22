// Review-only semantic regression. Proposed commands and synthetic delegations never execute.
import { join } from "node:path";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../shared/configuration/load.ts";
import { reviewerLabel } from "../../shared/review/client.ts";
import { buildReview, reviewAction } from "../review.ts";
import { cgroupReviewFixtures } from "./cgroup-review-fixtures.ts";

const agentDir = getAgentDir();
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  modelsStorePath: join(agentDir, "models-store.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const registry = new ModelRegistry(runtime);
const config = await loadConfig(agentDir);
let failures = 0;

for (const fixture of cgroupReviewFixtures) {
  const envelope = buildReview(
    fixture.action,
    fixture.entries,
    config,
    "/project",
    ["/home/operator/.pi"],
    fixture.sandboxPlan,
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

if (failures) throw new Error(`${failures} cgroup review evaluations failed`);

console.log(`${cgroupReviewFixtures.length} semantic cases passed; no proposed action executed.`);
