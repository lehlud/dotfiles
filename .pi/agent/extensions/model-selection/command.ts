import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Reviewer } from "../shared/review/protocol.ts";
import { sessionServices } from "../shared/session/services.ts";
import { chooseReviewers, interactiveReviewerInput } from "./interactive.ts";
import { describeReviewers, REVIEWER_USAGE, updateReviewers } from "./reviewers.ts";

export function registerReviewerCommand(
  pi: ExtensionAPI,
  current: () => Reviewer[],
  save: (reviewers: Reviewer[], ctx: ExtensionContext) => void,
) {
  let dialog: AbortController | undefined;
  const close = () => dialog?.abort();

  pi.on("session_start", close);
  pi.on("session_shutdown", close);
  pi.on("session_tree", close);

  async function choose(input: string, ctx: ExtensionContext) {
    if (dialog) {
      ctx.ui.notify("Reviewer selection is already open.", "warning");

      return;
    }

    const opening = new AbortController();
    const previous = current();

    dialog = opening;

    try {
      const next = await chooseReviewers(input, previous, ctx, opening.signal);

      if (!opening.signal.aborted && previous === current()) return next;
    } catch (error) {
      if (!opening.signal.aborted) throw error;
    } finally {
      if (dialog === opening) dialog = undefined;
    }
  }

  pi.registerCommand("reviewer", {
    description:
      "Choose approval models and thinking interactively, or manage them with subcommands; changes apply at the next turn.",
    handler: async (args, ctx) => {
      try {
        const input = args.trim();

        if (input !== "list") {
          let next;

          if (interactiveReviewerInput(input)) {
            next = await choose(input, ctx);
          } else {
            close();
            next = updateReviewers(input, current(), ctx);
          }

          if (!next) return;

          save(next, ctx);
        }

        const reviewers = current();
        const pending =
          JSON.stringify(sessionServices(ctx).activeReviewers?.()) !== JSON.stringify(reviewers);

        ctx.ui.notify(
          `Reviewers (priority order)${pending ? " · queued for next turn" : ""}:\n${describeReviewers(reviewers, ctx)}\nSaved for new sessions. In-flight reviews keep their selected models.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`${String(error)}\n${REVIEWER_USAGE}`, "error");
      }
    },
  });
}
