import { buildEvidence, type Entry } from "../shared/review/evidence.ts";
import { checkActionSize } from "../shared/review/context.ts";
import type { Request } from "../shared/contracts/action.ts";
import type { Config } from "../shared/configuration/schemas.ts";
import type { PreparedPrompts } from "../shared/review/compression.ts";
import { requestVerdict } from "../shared/review/client.ts";
import { REVIEW_SYSTEM, WRITING_REVIEW_SYSTEM } from "./review-policy.ts";

type VerdictArguments = Parameters<typeof requestVerdict>;

/** The shared verdict client receives policy explicitly and cannot authorize an action on its own. */
export function reviewAction(
  config: VerdictArguments[0],
  registry: VerdictArguments[1],
  envelope: VerdictArguments[2],
  observer: VerdictArguments[3],
  signal?: AbortSignal,
  systemPrompt?: string,
  availability?: VerdictArguments[6],
  processing?: VerdictArguments[7],
) {
  const policy =
    systemPrompt ??
    (JSON.parse(envelope.text).action?.tool === "writing_check"
      ? WRITING_REVIEW_SYSTEM
      : REVIEW_SYSTEM);

  return requestVerdict(
    config,
    registry,
    envelope,
    observer,
    signal,
    policy,
    availability,
    processing,
  );
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
