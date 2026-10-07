import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoals } from "./goals.ts";
import { registerSide } from "./side.ts";
import { registerSteering } from "./steering.ts";
import { sessionServices } from "../auto-approval/session-services.ts";

/** Gesprächssteuerung besitzt weder Executor noch Freigaberechte. */
export default function conversations(pi: ExtensionAPI) {
  registerGoals(pi);
  registerSide(pi);
  registerSteering(pi, (ctx) => sessionServices(ctx).operatorGoal?.());
}
