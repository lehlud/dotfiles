import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TeamController } from "./controller.ts";
export { MAX_AGENTS, MULTIPLEX_STATUS } from "./controller.ts";

export default function multiplex(pi: ExtensionAPI) {
  new TeamController(pi).register();
}
