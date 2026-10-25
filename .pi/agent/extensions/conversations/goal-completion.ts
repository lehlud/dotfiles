import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReviewError } from "../shared/review/client.ts";
import { sessionServices } from "../shared/session/services.ts";
import type { Goal } from "./goal-state.ts";
import { buildGoalReview, verifyGoal } from "./goal-review.ts";

type CompletionOptions = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  goal: Goal;
  signal: AbortSignal;
  isCurrent(): boolean;
  operatorPending(): boolean;
  display(status: string): void;
};

type CompletionResult =
  | { kind: "superseded"; retry: boolean }
  | { kind: "decision"; goal: Goal; notice: string; waiting: boolean };

/** One independent evidence snapshot; never activates goals or authorizes actions. */
export class GoalCompletion {
  private envelope?: ReturnType<typeof buildGoalReview>;
  constructor(private options: CompletionOptions) {}

  async run(): Promise<CompletionResult | undefined> {
    const { pi, ctx, goal, signal, isCurrent, operatorPending, display } = this.options;
    const services = sessionServices(ctx);
    const peerRevision = services.peerRevision?.();
    const subagentRevision = services.subagentRevision?.();
    const jobRevision = services.jobs?.revision;
    const checked = await verifyGoal(pi, ctx, goal, signal, display, (envelope) => {
      this.envelope = envelope;
    });

    signal.throwIfAborted();

    if (!isCurrent()) return;

    const changed =
      services.peerRevision?.() !== peerRevision ||
      services.subagentRevision?.() !== subagentRevision ||
      services.jobs?.revision !== jobRevision;
    const busy =
      (services.peersBusy?.() ?? false) ||
      (services.subagentsBusy?.() ?? false) ||
      !!services.jobs?.busy;
    const superseded = ctx.hasPendingMessages() || changed || busy || operatorPending();

    pi.appendEntry("auto-approval-goal-review", {
      goalId: goal.id,
      requestId: this.envelope!.requestId,
      fingerprint: this.envelope!.fingerprint,
      ...checked,
      superseded,
    });

    // Queued user input runs first. Settled peer changes need a fresh turn;
    // ongoing peers wake the controller when they finish.
    if (superseded)
      return { kind: "superseded", retry: !ctx.hasPendingMessages() && changed && !busy };

    return this.decision(checked.verdict);
  }

  private decision(verdict: Awaited<ReturnType<typeof verifyGoal>>["verdict"]): CompletionResult {
    const complete = verdict.decision === "approve";
    const waiting = !complete && verdict.blocked === true;
    const label = complete ? "confirmed" : waiting ? "waiting" : "incomplete";
    const notice = [`Goal ${label}: ${verdict.reason}`];

    if (waiting)
      notice.push("Waiting for external input; use /goal resume or /continue after resolving it.");

    return {
      kind: "decision",
      goal: {
        ...this.options.goal,
        checks: this.options.goal.checks + 1,
        status: complete ? "complete" : waiting ? "paused" : "running",
        reason: verdict.reason,
        feedback: complete ? undefined : verdict.reason,
      },
      notice: notice.join("\n"),
      waiting,
    };
  }

  recordFailure(error: unknown) {
    this.options.pi.appendEntry("auto-approval-goal-review-error", {
      goalId: this.options.goal.id,
      requestId: this.envelope?.requestId,
      fingerprint: this.envelope?.fingerprint,
      reason: String(error),
      attempts: error instanceof ReviewError ? error.attempts : [],
      usage: error instanceof ReviewError ? error.usage : undefined,
    });
  }
}
