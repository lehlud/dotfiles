import {
  STATE_ENTRY,
  STATUS_KEY,
  instruction,
  goalTitle,
  message,
  type Goal,
  type GoalReview,
} from "./goal-state.ts";
import { randomUUID } from "node:crypto";
import type {
  BoundaryResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assertSandboxReady, loadConfig } from "../shared/configuration/load.ts";
import { buildGoalReview, verifyGoal } from "./goal-review.ts";
import { ReviewChainError } from "../shared/review/client.ts";
import { operatorPromptRecords } from "../shared/review/prompts.ts";
import type { GoalSource } from "../shared/contracts/goal.ts";
import { sessionServices } from "../shared/session/services.ts";

export class GoalController {
  goal: Goal | undefined;
  private revision = 0;
  private pendingOperator?: number;
  private reviewController: AbortController | undefined;
  constructor(private pi: ExtensionAPI) {}

  display = (ctx: ExtensionContext, status?: string) =>
    ctx.ui.setStatus(
      STATUS_KEY,
      this.goal ? `goal: ${goalTitle(this.goal.text)} · ${status ?? this.goal.status}` : undefined,
    );
  record(next: Goal, ctx: ExtensionContext) {
    this.pi.appendEntry(STATE_ENTRY, next);
    this.goal = next;
    this.bindServices(ctx);
    this.display(ctx);
  }

  private bindServices(ctx: ExtensionContext) {
    sessionServices(ctx).setAgentGoal = (text, signal) =>
      this.activate(text, "agent", ctx, false, signal);

    sessionServices(ctx).resumeGoal = async (commandContext) => {
      if (this.goal?.status !== "paused") return false;

      await this.command("resume", commandContext);

      return true;
    };

    sessionServices(ctx).operatorGoal = () =>
      this.goal?.status === "running" && this.goal.source !== "agent" ? this.goal.text : undefined;
    sessionServices(ctx).interruptGoal = (reason) => {
      this.reviewController?.abort();
      this.pause(ctx, reason ?? "Interrupted by operator; use /goal resume");
    };

    sessionServices(ctx).operatorGoalId = () => this.goal?.id;
    sessionServices(ctx).goalInstruction = () =>
      this.goal?.status === "running" ? instruction(this.goal) : undefined;
  }

  shutdown(ctx: ExtensionContext) {
    this.revision++;
    this.pendingOperator = undefined;
    sessionServices(ctx).setAgentGoal = undefined;
    this.reviewController?.abort();
    this.goal = undefined;
    this.display(ctx);
  }

  pause(ctx: ExtensionContext, reason: string) {
    if (!this.goal || this.goal.status !== "running") return;

    // Even if persistence fails, no unchecked continuation is allowed.
    this.goal = { ...this.goal, status: "paused", reason };
    this.display(ctx);
    this.pi.appendEntry(STATE_ENTRY, this.goal);
  }

  restore(_event: unknown, ctx: ExtensionContext) {
    this.revision++;
    this.pendingOperator = undefined;
    this.bindServices(ctx);
    this.reviewController?.abort();
    ctx.ui.setStatus("goal", undefined); // Clear the old status key after reload.
    ctx.ui.setStatus("00-goal", undefined);

    const branch = ctx.sessionManager.getBranch();
    const last = branch
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
      .at(-1);
    const saved = last?.type === "custom" ? (last.data as Goal | undefined) : undefined;

    this.goal =
      saved &&
      typeof saved.text === "string" &&
      typeof saved.id === "string" &&
      Number.isInteger(saved.checks) &&
      (saved.source === undefined || saved.source === "operator" || saved.source === "agent") &&
      ["running", "paused", "complete", "stopped"].includes(saved.status)
        ? { ...saved }
        : undefined;

    // Older checkpoints mixed UI pause reasons into the model's missing-work
    // instruction. Recover real feedback from the goal's independent audit.
    if (this.goal) {
      const id = this.goal.id;
      const audits = branch.flatMap((entry) =>
        entry.type === "custom" &&
        entry.customType === "auto-approval-goal-review" &&
        (entry.data as GoalReview)?.goalId === id
          ? [entry.data as GoalReview]
          : [],
      );
      const audit = audits.filter((entry) => !entry.superseded).at(-1);

      if (audit)
        this.goal.feedback =
          audit.verdict?.decision === "deny" && typeof audit.verdict.reason === "string"
            ? audit.verdict.reason
            : undefined;
      else if (typeof this.goal.feedback !== "string") this.goal.feedback = undefined;
    }

    if (this.goal?.status === "running")
      this.record(
        {
          ...this.goal,
          status: "paused",
          reason:
            "Session restored; use /goal resume and recheck temporary artifacts after session shutdown",
        },
        ctx,
      );

    this.display(ctx);
  }

  async command(args: string, ctx: ExtensionCommandContext) {
    const text = args.trim();

    if (!text || text === "status") {
      ctx.ui.notify(
        this.goal
          ? `${this.goal.status}: ${this.goal.text}\n${this.goal.reason}\nChecks: ${this.goal.checks}`
          : "No goal. Use /goal <target>.",
        "info",
      );

      return;
    }

    if (text === "stop") {
      this.revision++;
      this.pendingOperator = undefined;
      this.reviewController?.abort();

      if (this.goal && ["running", "paused"].includes(this.goal.status)) {
        const stopped = {
          ...this.goal,
          status: "stopped" as const,
          reason: "Stopped by operator; completion not confirmed",
        };

        this.goal = stopped;
        ctx.abort();
        await sessionServices(ctx).stopTeam?.();
        this.record(stopped, ctx);
      }

      ctx.ui.notify("Goal stopped by operator; no completion claim.", "warning");

      return;
    }

    try {
      const resume = text === "resume";
      const replacing = this.goal && ["running", "paused"].includes(this.goal.status);
      const goal = await this.activate(
        resume ? (this.goal?.text ?? "") : text,
        "operator",
        ctx,
        resume,
      );

      ctx.ui.notify(
        `Goal ${resume ? "resumed" : replacing ? "updated" : "started"}: ${goal.text}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`Goal: ${String(error)}`, "error");
    }
  }

  private async ready(ctx: ExtensionContext, revision: number, signal?: AbortSignal) {
    signal?.throwIfAborted();

    if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
      throw new Error("Working model unavailable; configure it first.");
    }

    await assertSandboxReady(await loadConfig(getAgentDir()));
    signal?.throwIfAborted();

    if (revision !== this.revision) {
      throw new Error("Goal request superseded by a later control request");
    }
  }

  private agentTarget(text: string, ctx: ExtensionContext): Goal | undefined {
    const current = this.goal;
    const active = current && ["running", "paused"].includes(current.status);

    if (
      this.pendingOperator !== undefined ||
      (active && (current.source !== "agent" || current.text !== text))
    ) {
      throw new Error("An existing goal takes precedence; only the operator may replace it");
    }

    if (!operatorPromptRecords(ctx.sessionManager.getBranch()).length) {
      throw new Error("An agent goal needs an existing operator task");
    }

    return active ? current : undefined;
  }

  private start(next: Goal, ctx: ExtensionContext, resume: boolean) {
    this.record(next, ctx);
    this.reviewController?.abort();

    if (resume && ctx.isIdle()) {
      sessionServices(ctx).continueTeam?.(instruction(next));
    }

    sessionServices(ctx).resetProgress?.();
    this.pi.sendMessage(message(instruction(next)), { triggerTurn: true, deliverAs: "steer" });
  }

  private async activate(
    input: string,
    source: GoalSource,
    ctx: ExtensionContext,
    resume = false,
    signal?: AbortSignal,
  ): Promise<Goal> {
    signal?.throwIfAborted();

    const text = input.trim();
    const current = this.goal;

    if (source === "agent") {
      const existing = this.agentTarget(text, ctx);

      if (existing?.status === "running") {
        return existing;
      }

      resume = !!existing;
    }

    if (resume && current?.status !== "paused") {
      throw new Error("No paused goal to resume.");
    }

    if (!text || text.length > 8000) {
      throw new Error("Goal must contain 1–8000 characters.");
    }

    const revision = ++this.revision;

    if (source === "operator") {
      this.pendingOperator = revision;
    }

    let next: Goal | undefined;

    try {
      await this.ready(ctx, revision, signal);
      next = resume
        ? {
            ...current!,
            status: "running",
            reason: `Resumed by ${source}; completion not yet verified`,
          }
        : {
            id: randomUUID(),
            text,
            source,
            status: "running",
            checks: 0,
            reason: "Goal not yet verified",
          };

      if (source === "operator" && !resume) {
        this.pi.appendEntry("auto-approval-operator-prompt", { goalId: next.id, text });
      }

      this.start(next, ctx, resume);

      return next;
    } catch (error) {
      if (next && this.goal === next) {
        this.pause(ctx, "Start failed; use /goal resume after resolving the error");
      }

      throw error;
    } finally {
      if (this.pendingOperator === revision) {
        this.pendingOperator = undefined;
      }
    }
  }

  async check(event: TurnEndEvent, ctx: ExtensionContext): Promise<BoundaryResult | void> {
    const current = this.goal;

    if (current?.status !== "running") return;

    if (event.outcome !== "completed" || ctx.signal?.aborted) {
      this.pause(ctx, "Run interrupted or failed; use /goal resume");

      return;
    }

    if (
      event.message.role !== "assistant" ||
      event.message.content.some((block) => block.type === "toolCall") ||
      ctx.hasPendingMessages() ||
      this.pendingOperator !== undefined
    )
      return;

    // A team result can be reviewed only after peer actions have settled.
    if (sessionServices(ctx).peersBusy?.()) return;

    const controller = new AbortController();

    this.reviewController = controller;

    const signal = ctx.signal
      ? AbortSignal.any([controller.signal, ctx.signal])
      : controller.signal;
    let envelope: ReturnType<typeof buildGoalReview> | undefined;
    let peerRevision: number | undefined;

    try {
      peerRevision = sessionServices(ctx).peerRevision?.();

      const checked = await verifyGoal(
        this.pi,
        ctx,
        current,
        signal,
        (status) => {
          if (this.goal === current) this.display(ctx, status);
        },
        (prepared) => {
          envelope = prepared;
        },
      );

      signal.throwIfAborted();

      if (this.goal !== current) return;

      const peerChanged = sessionServices(ctx).peerRevision?.() !== peerRevision;
      const peersBusy = sessionServices(ctx).peersBusy?.() ?? false;
      const superseded =
        ctx.hasPendingMessages() || peerChanged || peersBusy || this.pendingOperator !== undefined;

      this.pi.appendEntry("auto-approval-goal-review", {
        goalId: current.id,
        requestId: envelope!.requestId,
        fingerprint: envelope!.fingerprint,
        ...checked,
        superseded,
      });

      // New operator input must run before a verdict on older context can settle
      // the goal. Pi drains the queued input without an extra extension turn.
      if (superseded) {
        // Already settled peer work triggers another turn after a stale verdict;
        // ongoing peers wake the goal review when they finish.
        if (!ctx.hasPendingMessages() && peerChanged && !peersBusy)
          return {
            continue: true,
            entries: [{ type: "custom_message", ...message(instruction(current)) }],
          };

        return;
      }

      const complete = checked.verdict.decision === "approve";

      this.record(
        {
          ...current,
          checks: current.checks + 1,
          status: complete ? "complete" : "running",
          reason: checked.verdict.reason,
          feedback: complete ? undefined : checked.verdict.reason,
        },
        ctx,
      );
      ctx.ui.notify(
        `Goal ${complete ? "confirmed" : "incomplete"}: ${checked.verdict.reason}`,
        "info",
      );

      if (!complete)
        return {
          continue: true,
          entries: [{ type: "custom_message", ...message(instruction(this.goal!)) }],
        };
    } catch (error) {
      if (this.goal !== current) return;

      if (this.goal?.id === current.id)
        this.pause(
          ctx,
          signal.aborted
            ? "Interrupted by operator; use /goal resume"
            : `Verification unavailable: ${String(error)}`,
        );

      this.pi.appendEntry("auto-approval-goal-review-error", {
        goalId: current.id,
        requestId: envelope?.requestId,
        fingerprint: envelope?.fingerprint,
        reason: String(error),
        attempts: error instanceof ReviewChainError ? error.attempts : [],
        usage: error instanceof ReviewChainError ? error.usage : undefined,
      });
      ctx.ui.notify(
        `Goal not confirmed: ${signal.aborted ? "interrupted" : String(error)}`,
        "warning",
      );
    } finally {
      if (this.reviewController === controller) this.reviewController = undefined;

      this.display(ctx);
    }
  }
}
