import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../configuration/load.ts";
import { ModelState } from "../configuration/model-state.ts";
import { pinnedSecurityConfig } from "./security-config.ts";
import { sessionServices } from "./services.ts";

/** Capture the active selection once; lookup rounds and retries keep that review identity. */
export function loadSessionConfig(ctx: ExtensionContext) {
  const selected = sessionServices(ctx).activeReviewer;

  const pinned = pinnedSecurityConfig();

  if (pinned)
    return Promise.resolve({
      ...pinned,
      reviewer: selected ? selected() : new ModelState(getAgentDir()).reviewer(),
    });

  return loadConfig(getAgentDir(), selected ? { reviewer: selected() } : {});
}
