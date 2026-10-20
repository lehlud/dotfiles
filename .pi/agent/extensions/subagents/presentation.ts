import {
  Container,
  Markdown,
  Text,
  parseColor,
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renderFileDiff } from "../shared/presentation/file-diff.ts";
import { writtenDiff } from "../shared/contracts/written-diff.ts";
import { textContent } from "../shared/review/protocol.ts";
import type { SubagentResult, SubagentActivity } from "../shared/contracts/subagents.ts";

export const ACTIVITY = "subagent-activity";
export const cleanActivity = (text: string) =>
  stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export function registerPresentation(pi: ExtensionAPI) {
  pi.registerEntryRenderer<SubagentActivity>(ACTIVITY, (entry, options, theme) => {
    const value = entry.data;

    if (!value || (value.kind === "tool" && value.diff === undefined && !value.isError)) return;

    const colors = ["#63b3ed", "#f6ad55", "#b794f4", "#68d391"];
    const title = theme.style(
      `Subagent · ${cleanActivity(value.name)} · ${cleanActivity(value.title)}`,
      {
        fg: parseColor(colors[value.color % colors.length]!),
      },
    );
    const header = new Text(title, 0, 0);

    if (value.diff !== undefined) return renderFileDiff(header, value.diff, options, theme);

    const body = cleanActivity(value.body ?? "").trim();

    if (!options.expanded)
      return {
        render(width) {
          return [
            truncateToWidth(`${title}${body ? theme.fg("muted", " · ctrl+o") : ""}`, width),
            ...(body ? [truncateToWidth(body.replace(/\s+/gu, " "), width)] : []),
          ];
        },
        invalidate() {},
      };

    const component = new Container();

    component.addChild(header);

    if (body) component.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));

    return component;
  });
}

export function observeTool(
  publish: (record: SubagentActivity) => void,
  job: SubagentResult,
  color: number,
  event: any,
) {
  if (event.type !== "tool_execution_end" || event.toolName !== "approved_action") return;

  const details = event.result?.details,
    receipt = details?.approval;
  const action = receipt?.action;
  const confirmed = !event.isError && receipt?.decision === "approve";
  const diff = confirmed
    ? action?.tool === "write"
      ? writtenDiff(receipt, details.result)
      : action?.tool === "edit"
        ? details.result?.diff
        : undefined
    : undefined;

  publish({
    agentId: job.id,
    kind: "tool",
    isError: !!event.isError,
    name: job.name,
    color,
    title: `${action?.tool ?? "action"}${action?.arguments?.path ? ` ${action.arguments.path}` : ""} · ${event.isError ? "Failed" : "Finished"}`,
    body: textContent(event.result?.content).slice(0, 24000),
    diff: typeof diff === "string" ? diff.slice(0, 48000) : undefined,
  });
}

export function display(ctx: ExtensionContext, jobs: SubagentResult[]) {
  const live = jobs.filter((job) => ["starting", "running", "idle"].includes(job.state));

  ctx.ui.setStatus("01-subagents", live.length ? `subagents: ${live.length}` : undefined);
  ctx.ui.setWidget(
    "subagents",
    live.length
      ? () => ({
          render(width: number) {
            return [
              "Subagent      State       Task",
              ...live.map(
                (job) =>
                  `${job.name.padEnd(12)}  ${job.state.padEnd(10)}  ${cleanActivity(job.task).replace(/\s+/g, " ")}`,
              ),
            ].map((line) => truncateToWidth(line, width));
          },
          invalidate() {},
        })
      : undefined,
  );
}
