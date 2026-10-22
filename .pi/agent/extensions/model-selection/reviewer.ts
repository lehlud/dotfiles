import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSelection } from "../shared/configuration/model-state.ts";
import { reviewerLabel } from "../shared/review/client.ts";
import type { Reviewer } from "../shared/review/protocol.ts";
import { reviewerThinkingLevels } from "./capabilities.ts";

export const REVIEWER_USAGE =
  "/reviewer [status | set [<provider/model> [thinking]] | thinking <level>]";

export function reviewerSelection(
  reference: string,
  thinking: string,
  ctx: ExtensionContext,
): Reviewer {
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

  if (!reviewerThinkingLevels(model).includes(candidate.thinking)) {
    throw new Error(`Thinking level ${thinking} is unsupported by ${reference}`);
  }

  return candidate;
}

/** Only operator commands can replace the reviewer; no list or automatic fallback exists. */
export function updateReviewer(
  args: string,
  previous: Reviewer | undefined,
  ctx: ExtensionContext,
) {
  const [operation, ...words] = args.trim().split(/\s+/);

  if (operation === "set" && words.length >= 1 && words.length <= 2) {
    return reviewerSelection(words[0], words[1] ?? previous?.thinking ?? "off", ctx);
  }

  if (operation === "thinking" && words.length === 1 && previous) {
    return reviewerSelection(`${previous.provider}/${previous.model}`, words[0], ctx);
  }

  throw new Error(REVIEWER_USAGE);
}

export function describeReviewer(reviewer: Reviewer | undefined, ctx: ExtensionContext) {
  if (!reviewer) return "None. Use /reviewer to choose one.";

  const model = ctx.modelRegistry.find(reviewer.provider, reviewer.model);
  const ready = model && ctx.modelRegistry.hasConfiguredAuth(model);

  return `${reviewerLabel(reviewer)}${ready ? "" : " · authentication unavailable"}`;
}
