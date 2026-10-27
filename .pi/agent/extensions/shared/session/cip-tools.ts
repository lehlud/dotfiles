import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
  CIP_NODES,
  cipNodesTool,
  cipNodeOperations,
  type CipNodeRequest,
} from "../contracts/remote.ts";
import { renderTextResult } from "../presentation/text-result.ts";
import { sessionServices } from "./services.ts";

/** /cip is operator consent for pool controls, never for commands on those nodes. */
export function availableCipTools(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
  return sessionServices(ctx).remote?.cip?.active() &&
    pi.getAllTools?.().some((tool) => tool.name === CIP_NODES)
    ? [CIP_NODES]
    : [];
}

export function registerCipTools(pi: ExtensionAPI) {
  pi.registerTool({
    ...cipNodesTool,
    exposure: "model-only",
    executionMode: "parallel",
    renderResult: renderTextResult,
    async execute(id, raw, signal, _update, ctx) {
      signal?.throwIfAborted();

      if (!Check(cipNodeOperations, raw)) throw new Error("Invalid CIP pool operation");

      const pool = sessionServices(ctx).remote?.cip;

      if (!pool?.active()) throw new Error("Enable /cip before using cip_nodes");

      const args = raw as CipNodeRequest;

      pi.appendEntry("cip-control", { id, phase: "started", arguments: args });

      try {
        const result = await pool.manage(args, signal);

        pi.appendEntry("cip-control", { id, phase: "completed", arguments: args });

        return result;
      } catch (error) {
        pi.appendEntry("cip-control", {
          id,
          phase: "failed",
          arguments: args,
          error: String(error),
        });

        throw error;
      }
    },
  });
}
