import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fastRoute, registerFastRequests } from "../shared/providers/fast.ts";
import { sessionServices } from "../shared/session/services.ts";

export const FAST_MODE_ENTRY = "fast-mode-state";

export default function fastMode(pi: ExtensionAPI) {
  let enabled = false;
  const current = () => enabled;
  const draw = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(
      "fast-mode",
      enabled ? (fastRoute(ctx.model) ? "fast" : "fast (main unsupported)") : undefined,
    );
  };
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    enabled = false;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === FAST_MODE_ENTRY) {
        const saved = entry.data as { enabled?: unknown };

        if (typeof saved?.enabled === "boolean") {
          enabled = saved.enabled;
        }
      }
    }

    sessionServices(ctx).fastMode = current;
    draw(ctx);
  };

  registerFastRequests(pi);
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", (_event, ctx) => draw(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("fast-mode", undefined);
    sessionServices(ctx).fastMode = undefined;
  });
  pi.registerCommand("fast", {
    description:
      "Toggle faster processing for working and review models: /fast [on|off|status]. May increase cost or usage.",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();

      if (!["", "on", "off", "status"].includes(mode)) {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");

        return;
      }

      if (mode !== "status") {
        const next = mode ? mode === "on" : !enabled;

        if (next !== enabled) {
          pi.appendEntry(FAST_MODE_ENTRY, { enabled: next });
          enabled = next;
        }
      }

      sessionServices(ctx).fastMode = current;
      draw(ctx);

      const route = fastRoute(ctx.model);
      const detail =
        route === "priority"
          ? "OpenAI priority processing"
          : route === "throughput"
            ? "OpenRouter highest-throughput eligible provider"
            : "no speed override for the working model; reviewers use their supported routes";

      ctx.ui.notify(
        enabled
          ? `Fast mode on · ${detail}. Applies to working and review requests; may increase cost or usage.`
          : "Fast mode off.",
        "info",
      );
    },
  });
}
