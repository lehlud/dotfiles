import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseReviewers, parseSelection } from "../shared/configuration/model-state.ts";
import { reviewerLabel } from "../shared/review/client.ts";
import type { Reviewer } from "../shared/review/protocol.ts";

export const REVIEWER_USAGE =
  "/reviewer [list | set <provider/model> [thinking] | add <provider/model> [thinking] | remove <index> | move <from> <to> | thinking <level> [index]]";

function index(value: string | undefined, length: number): number {
  if (!value || !/^[1-8]$/.test(value) || Number(value) > length) {
    throw new Error("Reviewer index must identify an existing entry (1–8)");
  }

  return Number(value) - 1;
}

function selection(reference: string, thinking: string, ctx: ExtensionContext): Reviewer {
  const separator = reference.indexOf("/");
  const candidate = parseSelection({
    provider: reference.slice(0, separator),
    model: reference.slice(separator + 1),
    thinking,
  });
  const model = ctx.modelRegistry.find(candidate.provider, candidate.model);

  if (separator < 1 || !model) {
    throw new Error(`Model not found: ${reference}. Use a provider/model identifier from /model.`);
  }

  if (
    candidate.thinking !== "off" &&
    (!model.reasoning ||
      (model.thinkingLevelMap && model.thinkingLevelMap[candidate.thinking] === undefined))
  ) {
    throw new Error(`Thinking level ${thinking} is unsupported by ${reference}`);
  }

  return candidate;
}

/** Only operator commands call this; a denied action cannot change its own reviewer. */
export function updateReviewers(args: string, previous: Reviewer[], ctx: ExtensionContext) {
  const words = args.trim().split(/\s+/);
  const operation = words.shift()!;
  const next = structuredClone(previous);

  switch (operation) {
    case "set":
    case "add": {
      if (words.length < 1 || words.length > 2) throw new Error(REVIEWER_USAGE);

      const candidate = selection(words[0], words[1] ?? next[0]?.thinking ?? "off", ctx);

      if (operation === "add") next.push(candidate);
      else next.splice(0, 1, candidate);

      break;
    }

    case "remove": {
      if (words.length !== 1) throw new Error(REVIEWER_USAGE);

      next.splice(index(words[0], next.length), 1);

      break;
    }

    case "move": {
      if (words.length !== 2) throw new Error(REVIEWER_USAGE);

      const from = index(words[0], next.length);
      const to = index(words[1], next.length);
      const [candidate] = next.splice(from, 1);

      next.splice(to, 0, candidate);

      break;
    }

    case "thinking": {
      if (words.length < 1 || words.length > 2) throw new Error(REVIEWER_USAGE);

      const position = index(words[1] ?? "1", next.length);
      const candidate = next[position];

      next[position] = selection(`${candidate.provider}/${candidate.model}`, words[0], ctx);

      break;
    }

    default:
      throw new Error(REVIEWER_USAGE);
  }

  return parseReviewers(next);
}

export function describeReviewers(reviewers: Reviewer[], ctx: ExtensionContext) {
  if (!reviewers.length)
    return "No reviewer selected. Set one with /reviewer set <provider/model> <thinking>.";

  return reviewers
    .map((item, i) => {
      const model = ctx.modelRegistry.find(item.provider, item.model);
      const ready = model && ctx.modelRegistry.hasConfiguredAuth(model);

      return `${i + 1}. ${reviewerLabel(item)}${ready ? "" : " · authentication unavailable"}`;
    })
    .join("\n");
}
