import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { reviewerSchema, type Reviewer } from "../review/protocol.ts";

export const reviewersSchema = Type.Array(reviewerSchema, {
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
});

export function parseReviewers(value: unknown): Reviewer[] {
  if (!Check(reviewersSchema, value)) {
    throw new Error("Reviewers must be 1–8 distinct provider/model/thinking selections");
  }

  return value;
}

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

  reviewers(): Reviewer[] {
    const value = this.read("reviewers.json");

    return value === undefined ? [] : parseReviewers(value);
  }

  saveWorking(value: Reviewer) {
    this.write("working.json", parseSelection(value));
  }

  saveReviewers(value: Reviewer[]) {
    this.write("reviewers.json", parseReviewers(value));
  }
}
