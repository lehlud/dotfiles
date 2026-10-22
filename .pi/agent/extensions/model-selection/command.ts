import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Reviewer } from "../shared/review/protocol.ts";
import { sessionServices } from "../shared/session/services.ts";
import { chooseReviewer, interactiveReviewerInput } from "./interactive.ts";
import { describeReviewer, REVIEWER_USAGE, updateReviewer } from "./reviewer.ts";

export function registerReviewerCommand(
  pi: ExtensionAPI,
  current: () => Reviewer | undefined,
  save: (reviewer: Reviewer, ctx: ExtensionContext) => void,
) {
  let dialog: AbortController | undefined;
  const close = () => dialog?.abort();

  pi.on("session_start", close);
  pi.on("session_shutdown", close);
  pi.on("session_tree", close);

  async function choose(ctx: ExtensionContext) {
    if (dialog) {
      ctx.ui.notify("Reviewer selection is already open.", "warning");

      return;
    }

    const opening = new AbortController();
    const previous = current();

    dialog = opening;

    try {
      const next = await chooseReviewer(previous, ctx, opening.signal);

      if (!opening.signal.aborted && previous === current()) return next;
    } catch (error) {
      if (!opening.signal.aborted) throw error;
    } finally {
      if (dialog === opening) dialog = undefined;
    }
  }

  pi.registerCommand("reviewer", {
    description:
      "Choose the approval model and thinking interactively; changes apply at the next turn.",
    handler: async (args, ctx) => {
      try {
        const input = args.trim();

        if (!["status", "list"].includes(input)) {
          let next;

          if (interactiveReviewerInput(input)) {
            next = await choose(ctx);
          } else {
            close();
            next = updateReviewer(input, current(), ctx);
          }

          if (!next) return;

          save(next, ctx);
        }

        const reviewer = current();
        const pending =
          JSON.stringify(sessionServices(ctx).activeReviewer?.()) !== JSON.stringify(reviewer);

        ctx.ui.notify(
          `Reviewer${pending ? " · queued for next turn" : ""}: ${describeReviewer(reviewer, ctx)}\nSaved for new sessions. In-flight reviews keep their selected model.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`${String(error)}\n${REVIEWER_USAGE}`, "error");
      }
    },
  });
}
