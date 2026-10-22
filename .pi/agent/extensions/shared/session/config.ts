import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../configuration/load.ts";
import { sessionServices } from "./services.ts";

/** Capture the active selection once; lookup rounds and retries keep that review identity. */
export function loadSessionConfig(ctx: ExtensionContext) {
  const selected = sessionServices(ctx).activeReviewer;

  return loadConfig(getAgentDir(), selected ? { reviewer: selected() } : {});
}
