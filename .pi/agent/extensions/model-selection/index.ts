import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ModelState } from "../shared/configuration/model-state.ts";
import { currentSelection, registerReviewSelection } from "../shared/session/model-selection.ts";
import { sessionServices } from "../shared/session/services.ts";
import { registerReviewerCommand } from "./command.ts";
import { registerModelFooter } from "./footer.ts";

export function registerModelSelection(pi: ExtensionAPI, agentDirectory: string) {
  const state = new ModelState(agentDirectory);

  state.migrateReviewer();

  let restoring = false;
  let desired = state.reviewer();
  const refreshReviewer = registerReviewSelection(pi, () => desired);

  registerModelFooter(pi);
  pi.on("session_start", async (event, ctx) => {
    desired = state.reviewer();
    refreshReviewer(event, ctx);

    const services = sessionServices(ctx);

    services.desiredReviewer = () => structuredClone(desired);
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
  registerReviewerCommand(
    pi,
    () => desired,
    (next, ctx) => {
      state.saveReviewer(next);
      desired = next;

      if (ctx.isIdle()) refreshReviewer({}, ctx);
    },
  );
}

export default function modelSelection(pi: ExtensionAPI) {
  registerModelSelection(pi, getAgentDir());
}
