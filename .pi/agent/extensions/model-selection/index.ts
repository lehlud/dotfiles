import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ModelState } from "../shared/configuration/model-state.ts";
import { currentSelection, registerReviewSelection } from "../shared/session/model-selection.ts";
import { sessionServices } from "../shared/session/services.ts";
import { describeReviewers, REVIEWER_USAGE, updateReviewers } from "./reviewers.ts";
import { registerModelFooter } from "./footer.ts";

export function registerModelSelection(pi: ExtensionAPI, agentDirectory: string) {
  const state = new ModelState(agentDirectory);
  let restoring = false;
  let desired = state.reviewers();
  const refreshReviewers = registerReviewSelection(pi, () => desired);

  registerModelFooter(pi);
  pi.on("session_start", async (event, ctx) => {
    desired = state.reviewers();
    refreshReviewers(event, ctx);

    const services = sessionServices(ctx);

    services.desiredReviewers = () => structuredClone(desired);
    services.workingModel = () => currentSelection(ctx);

    const fresh =
      event.reason === "new" ||
      (event.reason === "startup" &&
        !ctx.sessionManager.getBranch().some((entry) => entry.type === "message"));

    if (!fresh) return;

    const saved = state.working();

    if (!saved) {
      const current = currentSelection(ctx);

      if (current) state.saveWorking(current);

      return;
    }

    restoring = true;

    try {
      const model = ctx.modelRegistry.find(saved.provider, saved.model);

      if (!model || !(await pi.setModel(model))) {
        throw new Error(`Saved model unavailable: ${saved.provider}/${saved.model}`);
      }

      pi.setThinkingLevel(saved.thinking);
    } catch (error) {
      ctx.ui.notify(String(error), "error");
    } finally {
      restoring = false;
    }
  });

  const remember = (ctx: ExtensionContext) => {
    if (restoring) return;

    const current = currentSelection(ctx);

    if (current) state.saveWorking(current);
  };

  pi.on("model_select", (event, ctx) => {
    if (event.source !== "restore") remember(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => remember(ctx));
  pi.on("before_agent_start", (_event, ctx) => remember(ctx));
  pi.registerCommand("reviewer", {
    description:
      "Select persistent approval models and thinking levels; changes apply at the next turn.",
    handler: async (args, ctx) => {
      try {
        const input = args.trim();

        if (input && input !== "list") {
          const next = updateReviewers(input, desired, ctx);

          state.saveReviewers(next);
          desired = next;

          if (ctx.isIdle()) refreshReviewers({}, ctx);
        }

        const pending =
          JSON.stringify(sessionServices(ctx).activeReviewers?.()) !== JSON.stringify(desired);

        ctx.ui.notify(
          `Reviewers (priority order)${pending ? " · queued for next turn" : ""}:\n${describeReviewers(desired, ctx)}\nSaved for new sessions. In-flight reviews keep their selected models.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`${String(error)}\n${REVIEWER_USAGE}`, "error");
      }
    },
  });
}

export default function modelSelection(pi: ExtensionAPI) {
  registerModelSelection(pi, getAgentDir());
}
