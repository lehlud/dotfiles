import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installQueueEditor } from "./queue-input.ts";
import { registerQuestions } from "./questions/index.ts";
import { registerProgress } from "./progress.ts";
import { registerGoals } from "./goals.ts";
import { registerDialogues } from "./side.ts";
import { registerSteering } from "./steering.ts";
import { registerContinue } from "./continue.ts";
import { registerOperatorInputs } from "./operator-input.ts";
import { sessionServices } from "../shared/session/services.ts";

/** Conversation control owns no executor and cannot approve actions. */
export default function conversations(pi: ExtensionAPI) {
  registerQuestions(pi, installQueueEditor);
  registerOperatorInputs(pi);
  registerGoals(pi);
  registerProgress(pi);
  registerDialogues(pi);
  registerContinue(pi);
  registerSteering(pi, (ctx) => sessionServices(ctx).operatorGoal?.());
}
