import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { reviewerLabel, type ReviewObserver, type ReviewAttempt } from "../shared/review/client.ts";
import type { Reviewer } from "../shared/review/protocol.ts";
import { startReviewDisplay } from "./display.ts";
import type { ActionSession } from "./action-session.ts";
import type { buildReview } from "./review.ts";
import type { AvailabilityNotice } from "../shared/providers/availability.ts";

type Update = AgentToolUpdateCallback<unknown> | undefined;

export class ReviewDisplay {
  durationMs = 0;
  reviewer = "—";
  private stopDisplay?: () => number;
  constructor(
    private pi: ExtensionAPI,
    private ctx: ExtensionContext,
    private session: ActionSession,
    private id: string,
    private update: Update,
  ) {}

  finish() {
    if (!this.stopDisplay) return;

    this.durationMs += this.stopDisplay();
    this.session.displays.delete(this.stopDisplay);
    this.stopDisplay = undefined;
  }

  observers(review: ReturnType<typeof buildReview>, name: string): ReviewObserver {
    return {
      retry: (event: AvailabilityNotice) => {
        this.pi.appendEntry("auto-approval-provider-retry", {
          toolCallId: this.id,
          requestId: review.requestId,
          ...event,
        });
        this.update?.({
          content: [
            {
              type: "text",
              text: `Provider recovery · ${event.provider}/${event.model} · ${event.retry}/${event.maxRetries} · ${event.delayMs / 1000}s`,
            },
          ],
          details: { phase: "reviewing", retry: event },
        });
      },

      start: (candidate: Reviewer) => {
        this.reviewer = reviewerLabel(candidate);
        this.stopDisplay = startReviewDisplay(this.ctx, this.reviewer).stop;
        this.session.displays.add(this.stopDisplay);
        this.update?.({
          content: [{ type: "text", text: `⠋ Auto-Approval · ${this.reviewer} · ${name}` }],
          details: { phase: "reviewing", reviewer: this.reviewer },
        });
      },

      finish: () => this.finish(),
      failed: (attempt: ReviewAttempt) => {
        this.pi.appendEntry("auto-approval-reviewer-failure", {
          toolCallId: this.id,
          requestId: review.requestId,
          fingerprint: review.fingerprint,
          attempt,
        });
        this.update?.({
          content: [
            {
              type: "text",
              text: `Reviewer unavailable · ${reviewerLabel(attempt)}\n${attempt.reason}`,
            },
          ],
          details: { phase: "reviewing", reviewer: this.reviewer, attempt },
        });
      },

      lookup: (request: { promptId: string; operation: string }) => {
        this.pi.appendEntry("auto-approval-prompt-lookup", {
          requestId: review.requestId,
          fingerprint: review.fingerprint,
          request,
        });
        this.update?.({
          content: [
            {
              type: "text",
              text: `Reviewer original prompt · ${request.operation} · ${request.promptId.slice(0, 12)}`,
            },
          ],
          details: { phase: "reviewing", reviewer: this.reviewer, promptLookup: request },
        });
      },

      lookupFailed: (failure) => {
        this.pi.appendEntry("auto-approval-prompt-lookup-error", {
          requestId: review.requestId,
          fingerprint: review.fingerprint,
          failure,
        });
        this.update?.({
          content: [
            { type: "text", text: `Reviewer original prompt · correcting ${failure.code}` },
          ],
          details: { phase: "reviewing", reviewer: this.reviewer, promptLookupError: failure },
        });
      },
    };
  }
}
