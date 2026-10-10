import { randomUUID } from "node:crypto";
import type { BoundaryResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { assertSandboxReady, loadConfig } from "../auto-approval/config.ts";
import { buildGoalReview, GOAL_REVIEW_SYSTEM } from "./goal-review.ts";
import { reviewWithFallback, ReviewChainError } from "../auto-approval/reviews.ts";
import { preparePromptContext } from "../auto-approval/prompt-compression.ts";
import { sessionServices } from "../auto-approval/session-services.ts";

type Goal = { id: string; text: string; status: "running" | "paused" | "complete" | "stopped"; checks: number; reason: string; feedback?: string };
type GoalReview = { goalId?: string; superseded?: boolean; verdict?: { decision?: string; reason?: string } };
const STATE_ENTRY = "auto-approval-goal";
const INSTRUCTION_TYPE = "auto-approval-goal-instruction";
// Pi sorts footer statuses by key: team size, target, then transient review.
const STATUS_KEY = "01-goal";
function goalTitle(text: string) {
  const plain = stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/gu, " ").trim();
  return stripTerminalSequences(truncateToWidth(plain, 100, "…"));
}

const message = (text: string) => ({ customType: INSTRUCTION_TYPE, content: text, display: false });
const instruction = (current: Goal) => `Operator goal: ${current.text}\nContinue this existing task from the saved conversation until the independent goal reviewer confirms completion. Provide concrete evidence and required validation. All operations still require approved_action; respect denials and operator corrections. If the session was replaced or reloaded, recheck required temporary artifacts before reuse.${current.feedback ? `\nMissing work identified by the goal reviewer: ${current.feedback}` : ""}`;

class GoalController {
  goal: Goal | undefined;
  reviewController: AbortController | undefined;
  constructor(private pi: ExtensionAPI) {}
  display = (ctx: ExtensionContext, status?: string) => ctx.ui.setStatus(STATUS_KEY, this.goal ? `goal: ${goalTitle(this.goal.text)} · ${status ?? this.goal.status}` : undefined);
  record(next: Goal, ctx: ExtensionContext) {
    this.pi.appendEntry(STATE_ENTRY, next);
    this.goal = next;
    sessionServices(ctx).operatorGoal = () => this.goal?.status === "running" ? this.goal.text : undefined;
    sessionServices(ctx).interruptGoal = (reason) => { this.reviewController?.abort(); this.pause(ctx, reason ?? "Interrupted by operator; use /goal resume"); };
    sessionServices(ctx).operatorGoalId = () => this.goal?.id;
    sessionServices(ctx).goalInstruction = () => this.goal?.status === "running" ? instruction(this.goal) : undefined;
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
    sessionServices(ctx).operatorGoal = () => this.goal?.status === "running" ? this.goal.text : undefined;
    sessionServices(ctx).interruptGoal = (reason) => { this.reviewController?.abort(); this.pause(ctx, reason ?? "Interrupted by operator; use /goal resume"); };
    sessionServices(ctx).operatorGoalId = () => this.goal?.id;
    sessionServices(ctx).goalInstruction = () => this.goal?.status === "running" ? instruction(this.goal) : undefined;
    this.reviewController?.abort();
    ctx.ui.setStatus("goal", undefined); // Clear the old status key after reload.
    ctx.ui.setStatus("00-goal", undefined);
    const branch = ctx.sessionManager.getBranch();
    const last = branch.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY).at(-1);
    const saved = last?.type === "custom" ? last.data as Goal | undefined : undefined;
    this.goal = saved && typeof saved.text === "string" && typeof saved.id === "string" && Number.isInteger(saved.checks) && ["running", "paused", "complete", "stopped"].includes(saved.status) ? { ...saved } : undefined;
    // Older checkpoints mixed UI pause reasons into the model's missing-work
    // instruction. Recover real feedback from the goal's independent audit.
    if (this.goal) {
      const id = this.goal.id;
      const audits = branch.flatMap((entry) => entry.type === "custom" && entry.customType === "auto-approval-goal-review" && (entry.data as GoalReview)?.goalId === id ? [entry.data as GoalReview] : []);
      const audit = audits.filter((entry) => !entry.superseded).at(-1);
      if (audit) this.goal.feedback = audit.verdict?.decision === "deny" && typeof audit.verdict.reason === "string" ? audit.verdict.reason : undefined;
      else if (typeof this.goal.feedback !== "string") this.goal.feedback = undefined;
    }
    if (this.goal?.status === "running") this.record({ ...this.goal, status: "paused", reason: "Session restored; use /goal resume and recheck temporary artifacts after session shutdown" }, ctx);
    this.display(ctx);
  }

  async command(args: string, ctx: ExtensionCommandContext) {
    const text = args.trim();
    if (!text || text === "status") {
      ctx.ui.notify(this.goal ? `${this.goal.status}: ${this.goal.text}\n${this.goal.reason}\nChecks: ${this.goal.checks}` : "No goal. Use /goal <target>.", "info");
      return;
    }
    if (text === "stop") {
      this.reviewController?.abort();
      if (this.goal && ["running", "paused"].includes(this.goal.status)) {
        const stopped = { ...this.goal, status: "stopped" as const, reason: "Stopped by operator; completion not confirmed" };
        this.goal = stopped;
        ctx.abort();
        await sessionServices(ctx).stopTeam?.();
        this.record(stopped, ctx);
      }
      ctx.ui.notify("Goal stopped by operator; no completion claim.", "warning");
      return;
    }
    let started = false;
    try {
      if (!ctx.isIdle()) throw new Error("An agent run is active. Use /goal stop to interrupt it first.");
      if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("Working model unavailable; configure it first.");
      await assertSandboxReady(await loadConfig(getAgentDir()));
      if (text === "resume") {
        if (this.goal?.status !== "paused") throw new Error("No paused goal to resume.");
        this.record({ ...this.goal, status: "running", reason: "Resumed by operator; completion not yet verified" }, ctx);
      } else {
        if (this.goal && ["running", "paused"].includes(this.goal.status)) throw new Error("A goal already exists. Resume it or stop it before replacing it.");
        if (text.length > 8000) throw new Error("Goal is too long (maximum 8000 characters).");
        const next: Goal = { id: randomUUID(), text, status: "running", checks: 0, reason: "Goal not yet verified" };
        this.pi.appendEntry("auto-approval-operator-prompt", { goalId: next.id, text });
        this.record(next, ctx);
      }
      sessionServices(ctx).resetProgress?.();
      started = true;
      this.pi.sendMessage(message(instruction(this.goal!)), { triggerTurn: true });
      ctx.ui.notify(`Goal ${text === "resume" ? "resumed" : "started"}: ${this.goal!.text}`, "info");
    } catch (error) {
      if (started) this.pause(ctx, "Start failed; use /goal resume after resolving the error");
      ctx.ui.notify(`Goal: ${String(error)}`, "error");
    }
  }

  async check(event: TurnEndEvent, ctx: ExtensionContext): Promise<BoundaryResult | void> {
    const current = this.goal;
    if (current?.status !== "running") return;
    if (event.outcome !== "completed" || ctx.signal?.aborted) { this.pause(ctx, "Run interrupted or failed; use /goal resume"); return; }
    if (event.message.role !== "assistant" || event.message.content.some((block) => block.type === "toolCall") || ctx.hasPendingMessages()) return;
    // A team result can be reviewed only after peer actions have settled.
    if (sessionServices(ctx).peersBusy?.()) return;
    const controller = new AbortController();
    this.reviewController = controller;
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
    let envelope: ReturnType<typeof buildGoalReview> | undefined;
    let peerRevision: number | undefined;
    try {
      const config = await loadConfig(getAgentDir());
      peerRevision = sessionServices(ctx).peerRevision?.();
      const branch = ctx.sessionManager.getBranch();
      const prepared = await preparePromptContext(branch, config, ctx.modelRegistry, getAgentDir(), {
        start: () => this.display(ctx, "compressing"),
        saved: (record) => {
          if (!branch.some((entry) => entry.type === "custom" && entry.customType === "auto-approval-prompt-compression" && (entry.data as any)?.promptId === record.promptId && (entry.data as any)?.text === record.text)) this.pi.appendEntry("auto-approval-prompt-compression", record);
        },
        failed: (attempt) => this.pi.appendEntry("auto-approval-compressor-failure", { goalId: current.id, attempt }),
      }, signal, current.text);
      envelope = buildGoalReview(current.text, branch, config, ctx.cwd, current.id, prepared);
      const requestId = envelope.requestId;
      const checked = await reviewWithFallback(config, ctx.modelRegistry, envelope, {
        start: () => this.display(ctx, "checking"),
        finish() {},
        failed: (attempt) => this.pi.appendEntry("auto-approval-goal-reviewer-failure", { goalId: current.id, requestId, attempt }),
        lookup: (request) => this.pi.appendEntry("auto-approval-prompt-lookup", { goalId: current.id, requestId, request }),
      }, signal, GOAL_REVIEW_SYSTEM);
      signal.throwIfAborted();
      if (this.goal !== current) return;
      const peerChanged = sessionServices(ctx).peerRevision?.() !== peerRevision;
      const peersBusy = sessionServices(ctx).peersBusy?.() ?? false;
      const superseded = ctx.hasPendingMessages() || peerChanged || peersBusy;
      this.pi.appendEntry("auto-approval-goal-review", { goalId: current.id, requestId: envelope.requestId, fingerprint: envelope.fingerprint, ...checked, superseded });
      // New operator input must run before a verdict on older context can settle
      // the goal. Pi drains the queued input without an extra extension turn.
      if (superseded) {
        // Already settled peer work triggers another turn after a stale verdict;
        // ongoing peers wake the goal review when they finish.
        if (!ctx.hasPendingMessages() && peerChanged && !peersBusy) return { continue: true, entries: [{ type: "custom_message", ...message(instruction(current)) }] };
        return;
      }
      const complete = checked.verdict.decision === "approve";
      this.record({ ...current, checks: current.checks + 1, status: complete ? "complete" : "running", reason: checked.verdict.reason, feedback: complete ? undefined : checked.verdict.reason }, ctx);
      ctx.ui.notify(`Goal ${complete ? "confirmed" : "incomplete"}: ${checked.verdict.reason}`, "info");
      if (!complete) return { continue: true, entries: [{ type: "custom_message", ...message(instruction(this.goal!)) }] };
    } catch (error) {
      if (this.goal?.id === current.id) this.pause(ctx, signal.aborted ? "Interrupted by operator; use /goal resume" : `Verification unavailable: ${String(error)}`);
      this.pi.appendEntry("auto-approval-goal-review-error", { goalId: current.id, requestId: envelope?.requestId, fingerprint: envelope?.fingerprint, reason: String(error), attempts: error instanceof ReviewChainError ? error.attempts : [], usage: error instanceof ReviewChainError ? error.usage : undefined });
      ctx.ui.notify(`Goal not confirmed: ${signal.aborted ? "interrupted" : String(error)}`, "warning");
    } finally {
      if (this.reviewController === controller) this.reviewController = undefined;
      this.display(ctx);
    }
  }
}

export function registerGoals(pi: ExtensionAPI) {
  const controller = new GoalController(pi);
  pi.on("session_start", (event, ctx) => controller.restore(event, ctx));
  pi.on("session_tree", (event, ctx) => controller.restore(event, ctx));
  pi.on("session_shutdown", (_event, ctx) => { controller.reviewController?.abort(); controller.goal = undefined; controller.display(ctx); });
  pi.on("turn_end", (event, ctx) => controller.check(event, ctx));
  pi.on("context", (event) => {
    if (controller.goal?.status !== "running") return;
    // Replace obsolete control hints only in the request, never in the saved
    // transcript. One current instruction also avoids repeating the target.
    const messages = event.messages.filter((entry) => entry.role !== "custom" || entry.customType !== INSTRUCTION_TYPE);
    return { messages: [...messages, { role: "custom", ...message(instruction(controller.goal)), timestamp: Date.now() }] };
  });
  pi.registerCommand("goal", {
    description: "Run until independent goal verification: /goal <target>, status, resume, stop",
    handler: (args, ctx) => controller.command(args, ctx),
  });
  return () => controller.goal?.status === "running" ? controller.goal.text : undefined;
}
