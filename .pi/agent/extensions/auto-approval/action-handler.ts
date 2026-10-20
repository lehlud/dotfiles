import {
  getAgentDir,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sessionServices, type ActionLease } from "../shared/session/services.ts";
import { preparePromptContext } from "../shared/review/compression.ts";
import { reviewerLabel, ReviewChainError } from "../shared/review/client.ts";
import { buildReview, reviewWithFallback } from "./review.ts";
import { reviewSummary } from "./display.ts";
import { ReviewDisplay } from "./review-display.ts";
import { ProtectedPaths } from "./protected-paths.ts";
import { prepareAction, type PreparedAction } from "./prepare-action.ts";
import { executeWithCredentials } from "./credential-access.ts";
import { executeWithGitConfig } from "./git-config.ts";
import { executeIsolated } from "./isolation.ts";
import { isWebTool } from "../web-research/index.ts";
import type { ActionSession } from "./action-session.ts";

type Execution = Parameters<ToolDefinition<any, any>["execute"]>;

class ActionRun {
  private usage?: AssistantMessage["usage"];
  private assignment?: ActionLease;
  private executionStarted = false;
  private phase = "request validation";
  private summary = "";
  private audit: Record<string, unknown>;
  private display: ReviewDisplay;

  constructor(
    private pi: ExtensionAPI,
    private session: ActionSession,
    private protection: ProtectedPaths,
    private id: string,
    private raw: unknown,
    private signal: Execution[2],
    private update: Execution[3],
    private ctx: Execution[4],
  ) {
    const mailbox = sessionServices(ctx).mailbox;

    this.audit = {
      toolCallId: id,
      decision: "deny",
      ...(mailbox?.active() ? { multiplexAgent: mailbox.name } : {}),
    };
    this.display = new ReviewDisplay(pi, ctx, session, id, update);
  }

  async run() {
    try {
      this.signal?.throwIfAborted();
      this.phase = "team coordination";
      this.assignment =
        sessionServices(this.ctx).mailbox?.beginAction?.() ??
        sessionServices(this.ctx).acquireActionLease?.();
      this.phase = "request validation";

      const prepared = await prepareAction(
        this.raw,
        this.ctx,
        this.session,
        this.protection,
        (phase) => {
          this.phase = phase;
        },
      );
      const verdict = await this.review(prepared);

      this.signal?.throwIfAborted();
      // Persistence must succeed before approval can authorize execution.
      this.pi.appendEntry("auto-approval-review", this.audit);
      sessionServices(this.ctx).mailbox?.audit(this.audit);
      this.update?.({ content: [{ type: "text", text: this.summary }], details: this.audit });

      if (verdict.decision === "deny") return this.denied();

      this.signal?.throwIfAborted();
      this.phase = "team coordination";
      this.assignment?.assertCurrent();
      this.executionStarted = true;

      return await this.execute(prepared);
    } catch (error) {
      return this.failed(error);
    } finally {
      this.assignment?.release();
      this.display.finish();
      this.ctx.ui.setStatus("auto-approval", undefined);
    }
  }

  private async review({
    request,
    config,
    workspace,
    credentialPlan,
    sandboxPlan,
  }: PreparedAction) {
    this.phase = "prompt compression";

    const branch = this.ctx.sessionManager.getBranch();
    const operatorGoal = sessionServices(this.ctx).operatorGoal?.();
    const prepared = await preparePromptContext(
      branch,
      config,
      this.ctx.modelRegistry,
      getAgentDir(),
      {
        start: (label) =>
          this.update?.({
            content: [{ type: "text", text: `Prompt compression · ${label}` }],
            details: { phase: "compressing" },
          }),
        saved: (record) => {
          if (
            !branch.some(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "auto-approval-prompt-compression" &&
                (entry.data as { promptId?: string; text?: string })?.promptId ===
                  record.promptId &&
                (entry.data as { text?: string })?.text === record.text,
            )
          )
            this.pi.appendEntry("auto-approval-prompt-compression", record);
        },

        failed: (attempt) =>
          this.pi.appendEntry("auto-approval-compressor-failure", { toolCallId: this.id, attempt }),
      },
      this.signal,
      operatorGoal,
    );

    this.phase = "review context preparation";

    const review = buildReview(
      request,
      branch,
      config,
      this.ctx.cwd,
      [
        ...this.protection.paths,
        "[Additional operator-owned credential sources and executables: privately protected]",
      ],
      sandboxPlan,
      operatorGoal,
      prepared,
    );

    this.audit = {
      ...this.audit,
      action: request,
      reviewer: config,
      promptContext: prepared.records.map(({ original: _original, ...record }) => record),
      workspace: workspace.path,
      cwd: isWebTool(request.tool) || credentialPlan ? this.ctx.cwd : workspace.cwd,
      executionCwd: workspace.cwd,
      backend: config.sandbox.backend ?? "docker",
      sandboxPlan,
      requestId: review.requestId,
      fingerprint: review.fingerprint,
      operatorGoal,
    };
    this.phase = "independent review";
    this.display.reviewer = config.reviewers.map(reviewerLabel).join(" → ");

    const checked = await reviewWithFallback(
      config,
      this.ctx.modelRegistry,
      review,
      this.display.observers(review, request.tool),
      this.signal,
    );

    this.usage = checked.usage;
    this.signal?.throwIfAborted();
    this.audit = {
      ...this.audit,
      ...checked.verdict,
      selectedReviewer: checked.selectedReviewer,
      reviewAttempts: checked.attempts,
      promptLookups: checked.promptLookups,
      reviewDurationMs: this.display.durationMs,
    };
    this.summary = reviewSummary(
      checked.verdict.decision === "approve",
      checked.verdict.reason,
      this.display.durationMs,
      this.display.reviewer,
    );

    return checked.verdict;
  }

  private async execute({ request, workspace, config, credentialPlan }: PreparedAction) {
    const result = credentialPlan
      ? await executeWithCredentials(request, credentialPlan, config, this.signal, workspace)
      : request.sandbox?.gitConfig === true
        ? await executeWithGitConfig(request, workspace, config, this.signal)
        : await executeIsolated(request, workspace, config.sandbox, this.signal);

    if (isWebTool(request.tool))
      return {
        ...result,
        details: { approval: this.audit, approvalSummary: this.summary, result: result.details },
        usage: this.usage,
      };

    return {
      ...result,
      content: [{ type: "text" as const, text: this.summary }, ...result.content],
      details: { approval: this.audit, result: result.details },
      usage: this.usage,
    };
  }

  private denied() {
    return {
      content: [{ type: "text" as const, text: this.summary }],
      details: this.audit,
      usage: this.usage,
      isError: true,
    };
  }

  private failed(error: unknown) {
    this.display.finish();

    if (error instanceof ReviewChainError) {
      this.usage = error.usage;
      this.audit = { ...this.audit, reviewAttempts: error.attempts };
    }

    const reason = error instanceof Error ? error.message : String(error);

    if (this.executionStarted) {
      const failure = { approval: this.audit, executionError: reason };

      try {
        this.pi.appendEntry("auto-approval-execution-error", failure);
      } catch {
        /* Report failure even when persistence is unavailable. */
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `${this.summary}\nApproved action failed; it may have had side effects: ${reason}`,
          },
        ],
        details: failure,
        usage: this.usage,
        isError: true,
      };
    }

    this.audit = {
      ...this.audit,
      decision: "deny",
      reason,
      reviewDurationMs: this.display.durationMs,
      technicalFailure: true,
      technicalStage: this.phase,
    };
    this.summary = reviewSummary(
      false,
      `Blocked during ${this.phase}; nothing executed: ${reason}`,
      this.display.durationMs,
      this.display.reviewer,
    );

    try {
      this.pi.appendEntry("auto-approval-review", this.audit);
      sessionServices(this.ctx).mailbox?.audit(this.audit);
    } catch {
      /* Failure to save a rejection must still block execution. */
    }

    return this.denied();
  }
}

export function actionHandler(
  pi: ExtensionAPI,
  session: ActionSession,
): ToolDefinition<any, any>["execute"] {
  const protection = new ProtectedPaths();

  return (id, raw, signal, update, ctx) =>
    session.enqueue(() =>
      new ActionRun(pi, session, protection, id, raw, signal, update, ctx).run(),
    );
}
