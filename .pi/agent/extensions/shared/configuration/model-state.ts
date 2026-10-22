import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { reviewerSchema, type Reviewer } from "../review/protocol.ts";

const legacyReviewersSchema = Type.Array(reviewerSchema, {
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
});

export function parseSelection(value: unknown): Reviewer {
  if (!Check(reviewerSchema, value)) {
    throw new Error("Invalid saved model/thinking selection");
  }

  return value;
}

/** Operator-owned preferences; the entire agent directory is masked from model actions. */
export class ModelState {
  readonly directory: string;

  constructor(agentDirectory: string) {
    this.directory = join(agentDirectory, "state", "model-selection");
  }

  private read(name: string): unknown {
    const path = join(this.directory, name);

    try {
      if (!lstatSync(path).isFile()) {
        throw new Error(`Model preference must be a regular file: ${path}`);
      }

      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;

      throw error;
    }
  }

  private write(name: string, value: unknown) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });

    const path = join(this.directory, name);
    const temporary = join(this.directory, `.${name}.${randomUUID()}`);

    // Separate atomic files prevent a model change from overwriting a concurrent reviewer change.
    this.read(name);

    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  working(): Reviewer | undefined {
    const value = this.read("working.json");

    return value === undefined ? undefined : parseSelection(value);
  }

  reviewer(): Reviewer | undefined {
    const value = this.read("reviewer.json");

    if (value !== undefined) return parseSelection(value);

    const legacy = this.read("reviewers.json");

    if (legacy === undefined) return undefined;

    if (!Check(legacyReviewersSchema, legacy))
      throw new Error("Invalid legacy reviewer preferences");

    return legacy[0];
  }

  /** Import the active choice once; old sessions may still hold the legacy file open. */
  migrateReviewer() {
    if (this.read("reviewer.json") !== undefined) return;

    const selected = this.reviewer();

    if (selected) this.saveReviewer(selected);
  }

  saveWorking(value: Reviewer) {
    this.write("working.json", parseSelection(value));
  }

  saveReviewer(value: Reviewer) {
    this.write("reviewer.json", parseSelection(value));
  }
}
