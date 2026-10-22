import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import { sessionServices } from "../shared/session/services.ts";

function compact(value: number) {
  if (value < 1000) return String(value);

  if (value < 1000000) return `${(value / 1000).toFixed(1)}k`;

  return `${(value / 1000000).toFixed(1)}M`;
}

function oneLine(text: string) {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function modelLabel(ctx: ExtensionContext) {
  const model = ctx.model;
  const parts = [model ? `(${model.provider}) ${model.id}` : "no-model"];

  if (model?.reasoning) parts.push(ctx.thinkingLevel ?? "off");

  if (sessionServices(ctx).fastMode?.()) parts.push("fast");

  return parts.join(" · ");
}

function fitModelLabel(ctx: ExtensionContext, width: number) {
  const label = modelLabel(ctx);

  if (visibleWidth(label) <= width) return label;

  const suffix = [
    ...(ctx.model?.reasoning ? [ctx.thinkingLevel ?? "off"] : []),
    ...(sessionServices(ctx).fastMode?.() ? ["fast"] : []),
  ]
    .map((text) => ` · ${text}`)
    .join("");
  const available = width - visibleWidth(suffix);

  if (available <= 0) return truncateToWidth(suffix.trim(), width, "…");

  return truncateToWidth(ctx.model?.id ?? "no-model", available, "…") + suffix;
}

function usageSummary(ctx: ExtensionContext) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let hitRate: number | undefined;

  for (const entry of ctx.sessionManager.getEntries()) {
    const usage =
      "usage" in entry
        ? entry.usage
        : entry.type === "message" && "usage" in entry.message
          ? entry.message.usage
          : undefined;

    if (!usage) continue;

    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      totals[key] += usage[key];
    }

    totals.cost += usage.cost.total;

    if (entry.type === "message" && entry.message.role === "assistant") {
      const input = usage.input + usage.cacheRead + usage.cacheWrite;

      hitRate = input ? (100 * usage.cacheRead) / input : undefined;
    }
  }

  const parts = [
    ...(totals.input ? [`↑${compact(totals.input)}`] : []),
    ...(totals.output ? [`↓${compact(totals.output)}`] : []),
    ...(totals.cacheRead ? [`R${compact(totals.cacheRead)}`] : []),
    ...(totals.cacheWrite ? [`W${compact(totals.cacheWrite)}`] : []),
    ...(hitRate === undefined ? [] : [`CH${hitRate.toFixed(1)}%`]),
    ...(totals.cost ? [`$${totals.cost.toFixed(3)}`] : []),
  ];

  return parts.join(" ");
}

/** Public SDK data only: keep speed beside the model without adding a status row. */
export function modelFooter(ctx: ExtensionContext, data: ReadonlyFooterDataProvider) {
  let cachedLeaf: string | null | undefined;
  let usage = "";

  return {
    invalidate() {},
    render(width: number) {
      const manager = ctx.sessionManager;
      const leaf = manager.getLeafId();

      if (leaf !== cachedLeaf) {
        cachedLeaf = leaf;
        usage = usageSummary(ctx);
      }

      const path = relative(homedir(), ctx.cwd);
      const directory =
        path === "" ? "~" : path !== ".." && !path.startsWith(`..${sep}`) ? `~/${path}` : ctx.cwd;
      const branch = data.getGitBranch();
      const name = manager.getSessionName();
      const location = `${directory}${branch ? ` (${branch})` : ""}${name ? ` • ${name}` : ""}`;
      const context = ctx.getContextUsage();
      const budget = context
        ? `${context.percent === null ? "?" : context.percent.toFixed(1) + "%"}/${compact(context.contextWindow)}`
        : "";
      const right = fitModelLabel(ctx, width);
      const available = Math.max(0, width - visibleWidth(right) - 2);
      const left = available
        ? truncateToWidth([usage, budget].filter(Boolean).join(" "), available, "…")
        : "";
      const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
      const rows = [truncateToWidth(oneLine(location), width, "…"), left + padding + right];
      const statuses = [...data.getExtensionStatuses()]
        .filter(([key]) => key !== "fast-mode")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => oneLine(text));

      if (statuses.length) rows.push(truncateToWidth(statuses.join(" "), width, "…"));

      return rows;
    },
  };
}

export function registerModelFooter(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    sessionServices(ctx).inlineModelStatus = ctx.mode === "tui";

    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, data) => {
      const footer = modelFooter(ctx, data);
      const dispose = data.onBranchChange(() => tui.requestRender());

      return {
        invalidate: footer.invalidate,
        render: (width) => footer.render(width).map((line) => theme.fg("dim", line)),
        dispose,
      };
    });
  });
}
