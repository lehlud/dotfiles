import { actionSnapshot } from "../shared/contracts/action-snapshot.ts";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  renderDiff,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { clean, colorize, FeedView, messageBody } from "./presentation.ts";
import { randomUUID } from "node:crypto";

export const ACTIVITY_ENTRY = "multiplex-activity";
export const ACTIVITY_WIDGET = "multiplex-live";
export const FEED_ENTRY = "multiplex-feed";

export type ActivityEvent = Extract<
  AgentSessionEvent,
  {
    type:
      | "agent_start"
      | "agent_settled"
      | "message_update"
      | "message_end"
      | "tool_execution_start"
      | "tool_execution_update"
      | "tool_execution_end";
  }
>;

export type ActivityRecord = {
  teamId: string;
  from: string;
  kind: string;
  text: string;
  body: string;
  segment?: string;
  color?: number;
  diff?: string;
  path?: string;
  backend?: boolean;
  nativeTexts?: string[];
  toolCallId?: string;
};

type RunningTool = {
  label: string;
  name: string;
  path?: string;
  args: any;
  output: string;
  loggedAt: number;
};

type State = { status: string; preview: string; tools: Map<string, RunningTool> };

const plain = (value: any): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n")
      : "";
const bounded = (value: string) =>
  value.length > 65536
    ? `${value.slice(0, 65536)}\n[Activity preview truncated; complete output remains in the agent session.]`
    : value;
const toolLabel = (name: string, args: any) =>
  clean(name === "approved_action" ? String(args?.tool ?? name) : name)
    .replace(/\s+/g, " ")
    .slice(0, 60);

function toolBody(name: string, args: any) {
  let input = name === "approved_action" ? args?.arguments : args;

  if (name === "approved_action") {
    try {
      input = (actionSnapshot(args) as any)?.arguments;
    } catch {
      input = undefined;
    }

  }

  // Never copy credential profiles, environment values or arbitrary metadata.
  return ["command", "path", "url", "query"]
    .flatMap((key) => (typeof input?.[key] === "string" ? [input[key]] : []))
    .join("\n");
}

export function registerActivityRenderer(pi: ExtensionAPI, view = new FeedView()) {
  const draw = (
    record: ActivityRecord,
    expanded: boolean,
    theme: Parameters<typeof colorize>[0],
  ) => {
    const header = clean(`Agent · ${record.from} · ${record.text}`).replace(/\s+/g, " ");
    const body = messageBody(record.body, expanded);
    const diff = record.diff ? renderDiff(clean(record.diff), { filePath: record.path }) : "";

    return new Text(
      `${colorize(theme, record.color ?? 0, theme.bold(header))}${body ? `\n${body}` : ""}${diff ? `\n${diff}` : ""}`,
      0,
      0,
    );
  };

  pi.registerEntryRenderer<ActivityRecord>(ACTIVITY_ENTRY, (entry, options, theme) => {
    const record = entry.data;

    if (
      !record ||
      ["mailbox", "state", "thinking", "native-hidden"].includes(record.kind) ||
      record.segment
    )
      return;

    return view.filter(record.from, draw(record, options.expanded, theme));
  });

  pi.registerEntryRenderer<{ segment: string }>(FEED_ENTRY, (entry, options, theme) => {
    const segment = entry.data?.segment;

    if (!segment) return;

    const components = new Map<ActivityRecord, Text>();

    return {
      render(width) {
        const lines: string[] = [];

        for (const record of view.records(segment))
          if (
            !["state", "thinking", "native-hidden"].includes(record.kind) &&
            view.accepts(record.from)
          ) {
            let component = components.get(record);

            if (!component) {
              component = draw(record, options.expanded, theme);
              components.set(record, component);
            }

            if (lines.length) lines.push("");

            lines.push(...component.render(width));
          }

        return lines;
      },

      invalidate() {
        for (const component of components.values()) component.invalidate();

      },

    };
  });

}

/** Operator-only observation: entries never enter model context or actor mailboxes. */
export class TeamActivity {
  private states = new Map<string, State>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private segment = randomUUID();
  private anchored = false;
  constructor(
    private pi: ExtensionAPI,
    private ctx: ExtensionContext,
    private teamId: string,
    private backend: string,
    private names: readonly string[],
    private view = new FeedView(),
  ) {
    for (const name of names)
      this.states.set(name, { status: "Ready", preview: "", tools: new Map() });

    this.paint();
  }

  private record(
    from: string,
    kind: string,
    text: string,
    body = "",
    extra: Partial<ActivityRecord> = {},
  ) {
    const record = {
      ...extra,
      teamId: this.teamId,
      from,
      kind,
      text,
      body: bounded(body),
      color: this.names.indexOf(from),
      backend: from === this.backend,
      segment: this.segment,
    };

    this.pi.appendEntry<ActivityRecord>(ACTIVITY_ENTRY, record);
    this.view.append(record);
    this.view.refresh();
  }

  sent(from: string, to: readonly string[], text: string) {
    if (!this.closed && this.states.has(from))
      this.record(from, "send", `Message → ${to.join(", ")}`, text);

  }

  private paint() {
    this.timer = undefined;

    if (this.closed) return;

    this.ctx.ui.setWidget(ACTIVITY_WIDGET, (tui, theme) => {
      this.view.bind(tui);

      return {
        render: (width: number) => {
          const nameWidth = Math.max(5, ...this.names.map((name) => name.length));
          const stateWidth = Math.min(14, Math.max(6, width - nameWidth - 7));
          const prefix = (name: string, state: string) =>
            `${name.padEnd(nameWidth)}  ${truncateToWidth(state, stateWidth).padEnd(stateWidth)}  `;

          return [
            truncateToWidth(
              theme.fg(
                "muted",
                prefix("Agent", "State") + `Activity (${this.view.selected ?? "all"})`,
              ),
              width,
            ),
            ...[...this.states].map(([name, state]) => {
              const tasks = [...state.tools.values()].map((tool) => tool.label);
              const status = tasks.length ? "Running" : state.status;
              const preview = clean(tasks.length ? tasks.join(", ") : state.preview)
                .replace(/\s+/g, " ")
                .trim();
              const row = prefix(name, status) + preview;
              const colored =
                colorize(theme, this.names.indexOf(name), row.slice(0, nameWidth)) +
                row.slice(nameWidth);

              return truncateToWidth(colored, width);
            }),

          ];
        },

        invalidate() {},

      };
    });

  }

  refresh(immediate = false) {
    if (immediate) {
      if (this.timer) clearTimeout(this.timer);

      this.paint();
    } else this.timer ??= setTimeout(() => this.paint(), 80);

  }

  observe(from: string, event: ActivityEvent) {
    const state = this.states.get(from);

    if (this.closed || !state) return;

    if (
      from === this.backend &&
      event.type === "message_end" &&
      (event.message.role === "user" ||
        (event.message.role === "custom" &&
          event.message.customType === "auto-approval-goal-instruction"))
    ) {
      if (this.anchored) this.segment = randomUUID();

      this.pi.appendEntry(FEED_ENTRY, { teamId: this.teamId, segment: this.segment });
      this.anchored = true;
    }

    if (event.type === "agent_start") {
      state.status = "Working";
      state.preview = "";
    } else if (event.type === "agent_settled") {
      state.status = "Ready";
      state.tools.clear();
    } else if (event.type === "message_update" && event.message.role === "assistant") {
      const thinking = event.assistantMessageEvent.type.startsWith("thinking_");

      state.status = thinking
        ? "Thinking"
        : event.assistantMessageEvent.type.startsWith("toolcall_")
          ? "Preparing tool"
          : "Writing";
      state.preview = plain(event.message.content).slice(-240);

      if (from === this.backend) this.view.rootText(event.message.content);

    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const text = plain(event.message.content),
        nativeTexts =
          from === this.backend ? this.view.rootText(event.message.content, true) : undefined;

      state.preview = text.slice(-240);

      if (!text && nativeTexts?.length)
        this.pi.appendEntry(ACTIVITY_ENTRY, {
          teamId: this.teamId,
          from,
          kind: "native-hidden",
          backend: true,
          nativeTexts,
        });

      if (text) this.record(from, "message", "Reply", text, { nativeTexts });

      if (event.message.errorMessage)
        this.record(from, "error", "Model error", event.message.errorMessage);

    } else if (event.type === "tool_execution_start") {
      const label = toolLabel(event.toolName, event.args);
      let path = event.args?.arguments?.path;

      try {
        if (event.toolName === "approved_action")
          path = (actionSnapshot(event.args) as any)?.arguments?.path;

      } catch {
        /* No valid arguments to preview. */
      }

      state.tools.set(event.toolCallId, {
        label,
        name: event.toolName,
        path,
        args: event.toolName === "mailbox" ? { operation: event.args?.operation } : {},
        output: "",
        loggedAt: 0,
      });
      state.preview = "";

      if (from === this.backend) this.view.rootTool(event.toolCallId);

      if (event.toolName !== "mailbox")
        this.record(
          from,
          "tool-start",
          `${label} · Started`,
          toolBody(event.toolName, event.args),
          { toolCallId: event.toolCallId },
        );

    } else if (event.type === "tool_execution_update") {
      const tool = state.tools.get(event.toolCallId),
        output = plain(event.partialResult?.content);

      if (
        tool &&
        tool.name !== "mailbox" &&
        output &&
        output !== tool.output &&
        Date.now() - tool.loggedAt >= 1000
      ) {
        const delta = output.startsWith(tool.output) ? output.slice(tool.output.length) : output;

        this.record(from, "tool-output", `${tool.label} · Output`, delta);
        tool.output = output;
        tool.loggedAt = Date.now();
      }

    } else if (event.type === "tool_execution_end") {
      const tool = state.tools.get(event.toolCallId),
        label = tool?.label ?? event.toolName;

      state.tools.delete(event.toolCallId);
      state.status = "Working";

      if (event.toolName === "mailbox") {
        if (event.isError)
          this.record(from, "error", "Messagebox · Failed", plain(event.result?.content));
        else if (["plan", "accept", "withdraw"].includes(tool?.args.operation))
          this.record(
            from,
            "coordination",
            `Work split · ${event.result?.details?.ready ? "Ready" : "Planning"}`,
            event.result?.details?.assignments
              ?.map((item: any) => `${item.name}: ${item.task}${item.waiting ? " (waiting)" : ""}`)
              .join("\n") ?? "No work split",
          );
        else if (tool?.args.operation !== "send")
          this.record(
            from,
            "mailbox-query",
            "Messagebox",
            tool?.args.operation === "peers"
              ? `Members: ${event.result?.details?.members?.join(", ") ?? ""}`
              : `${event.result?.details?.length ?? 0} messages in inbox`,
          );

      } else {
        const details = event.result?.details;
        const diff =
          !event.isError &&
          event.toolName === "approved_action" &&
          label === "edit" &&
          details?.approval?.decision === "approve" &&
          details?.approval?.action?.tool === "edit" &&
          typeof details?.result?.diff === "string"
            ? bounded(details.result.diff)
            : undefined;

        this.record(
          from,
          "tool-end",
          diff
            ? `edit ${clean(tool?.path ?? "")}`
            : `${label} · ${event.isError ? "Failed" : "Finished"}`,
          plain(event.result?.content),
          { diff, path: tool?.path, toolCallId: event.toolCallId },
        );
      }

    }

    this.refresh(event.type !== "message_update" && event.type !== "tool_execution_update");
  }

  close() {
    this.closed = true;

    if (this.timer) clearTimeout(this.timer);

    this.timer = undefined;
    this.states.clear();
    this.ctx.ui.setWidget(ACTIVITY_WIDGET, undefined);
  }

}

