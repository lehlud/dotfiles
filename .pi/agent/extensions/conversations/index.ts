import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProgress } from "./progress.ts";
import { registerGoals } from "./goals.ts";
import { registerSide } from "./side.ts";
import { registerSteering } from "./steering.ts";
import { registerContinue } from "./continue.ts";
import { sessionServices } from "../shared/session/services.ts";

/** Conversation control owns no executor and cannot approve actions. */
export default function conversations(pi: ExtensionAPI) {
  registerGoals(pi);
  registerProgress(pi);
  registerSide(pi);
  registerContinue(pi);
  registerSteering(pi, (ctx) => sessionServices(ctx).operatorGoal?.());
}

