import { buildEvidence, type Entry } from "../shared/review/evidence.ts";
import { checkActionSize } from "../shared/review/context.ts";
import type { Request } from "../shared/contracts/action.ts";
import type { Config } from "../shared/configuration/schemas.ts";
import type { PreparedPrompts } from "../shared/review/compression.ts";
import { requestVerdict } from "../shared/review/client.ts";
import { REVIEW_SYSTEM } from "./review-policy.ts";

type VerdictArguments = Parameters<typeof requestVerdict>;
/** The shared verdict client receives policy explicitly and cannot authorize an action on its own. */
export function reviewWithFallback(
  config: VerdictArguments[0],
  registry: VerdictArguments[1],
  envelope: VerdictArguments[2],
  observer: VerdictArguments[3],
  signal?: AbortSignal,
  systemPrompt = REVIEW_SYSTEM,
  availability?: VerdictArguments[6],
) {
  return requestVerdict(config, registry, envelope, observer, signal, systemPrompt, availability);
}

export function buildReview(
  request: Request,
  entries: readonly Entry[],
  config: Config,
  cwd: string,
  protectedPaths: string[],
  sandboxPlan?: unknown,
  operatorGoal?: string,
  prepared?: PreparedPrompts,
) {
  checkActionSize(request);
  return buildEvidence(entries, config, cwd, {
    action: request,
    protectedPaths,
    sandboxPlan,
    operatorGoal,
    prepared,
  });
}
