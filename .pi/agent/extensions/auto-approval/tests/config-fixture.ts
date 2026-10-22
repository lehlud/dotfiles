import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ModelState, parseSelection } from "../../shared/configuration/model-state.ts";

/** Keep runtime reviewer choices separate from the portable security configuration. */
export async function writeConfigFixture(path: string, text: string) {
  const { reviewer, ...portable } = JSON.parse(text);

  if (reviewer !== undefined) {
    new ModelState(dirname(path)).saveReviewer(parseSelection(reviewer));
  }

  await writeFile(path, JSON.stringify(portable));
}
