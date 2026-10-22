import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ModelState, parseReviewers } from "../../shared/configuration/model-state.ts";

/** Keep runtime reviewer choices separate from the portable security configuration. */
export async function writeConfigFixture(path: string, text: string) {
  const { reviewers, ...portable } = JSON.parse(text);

  if (reviewers !== undefined) {
    new ModelState(dirname(path)).saveReviewers(parseReviewers(reviewers));
  }

  await writeFile(path, JSON.stringify(portable));
}
