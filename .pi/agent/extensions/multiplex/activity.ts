import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ACTIVITY_ENTRY = "multiplex-activity";
export const ACTIVITY_WIDGET = "multiplex-live";
export type ActivityEvent = Extract<AgentSessionEvent, { type: "agent_start" | "agent_settled" | "message_update" | "message_end" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>;
export type ActivityRecord = { teamId: string; from: string; kind: string; text: string; body: string };
type RunningTool = { label: string; output: string; loggedAt: number };
type State = { status: string; preview: string; tools: Map<string, RunningTool> };
const clean = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const plain = (value: any): string => typeof value === "string" ? value : Array.isArray(value) ? value.filter((item) => item.type === "text").map((item) => item.text).join("\n") : "";
const bounded = (value: string) => value.length > 65536 ? `${value.slice(0, 65536)}\n[Activity preview truncated; complete output remains in the agent session.]` : value;
const toolLabel = (name: string, args: any) => clean(name === "approved_action" ? String(args?.tool ?? name) : name).replace(/\s+/g, " ").slice(0, 60);
function toolBody(name: string, args: any) {
  if (name === "mailbox") return args?.operation === "send" ? `To: ${args.to}\n${args.text}` : String(args?.operation ?? "");
  const input = name === "approved_action" ? args?.arguments : args;
  // Never copy credential profiles, environment values or arbitrary metadata.
  return ["command", "path", "url", "query"].flatMap((key) => typeof input?.[key] === "string" ? [input[key]] : []).join("\n");
}

export function registerActivityRenderer(pi: ExtensionAPI) {
  pi.registerEntryRenderer<ActivityRecord>(ACTIVITY_ENTRY, (entry, options, theme) => {
    const record = entry.data;
    if (!record) return;
    const header = clean(`Agent · ${record.from} · ${record.text}`).replace(/\s+/g, " ");
    const body = clean(record.body), lines = body.split("\n");
    const shown = options.expanded ? body : lines.slice(0, 5).map((line) => truncateToWidth(line, 180)).join("\n");
    const hint = !options.expanded && (lines.length > 5 || lines.some((line) => line.length > 180)) ? "\n[ctrl+o to expand]" : "";
    return new Text(`${theme.fg("accent", theme.bold(header))}${body ? `\n${shown}${hint}` : ""}`, 0, 0);
  });
}

/** Operator-only observation: entries never enter model context or actor mailboxes. */
export class TeamActivity {
  private states = new Map<string, State>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private pi: ExtensionAPI, private ctx: ExtensionContext, private teamId: string, private main: string, names: readonly string[]) {
    for (const name of names) this.states.set(name, { status: "Ready", preview: "", tools: new Map() });
    this.paint();
  }
  private record(from: string, kind: string, text: string, body = "") {
    this.pi.appendEntry<ActivityRecord>(ACTIVITY_ENTRY, { teamId: this.teamId, from, kind, text, body: bounded(body) });
  }
  private paint() {
    this.timer = undefined;
    if (this.closed) return;
    this.ctx.ui.setWidget(ACTIVITY_WIDGET, (_tui, theme) => ({
      render: (width: number) => [theme.fg("accent", "Multiplex · All agents"), ...[...this.states].map(([name, state]) => {
        const tasks = [...state.tools.values()].map((tool) => tool.label);
        const status = tasks.length ? `Running ${tasks.join(", ")}` : state.status;
        const preview = clean(state.preview).replace(/\s+/g, " ").trim();
        return truncateToWidth(`${name}${name === this.main ? " (main transcript)" : ""} · ${status}${preview ? ` · ${preview}` : ""}`, width);
      })], invalidate() {},
    }));
  }
  private refresh(immediate = false) {
    if (immediate) { if (this.timer) clearTimeout(this.timer); this.paint(); }
    else this.timer ??= setTimeout(() => this.paint(), 80);
  }
  observe(from: string, event: ActivityEvent) {
    const state = this.states.get(from);
    if (this.closed || !state) return;
    if (event.type === "agent_start") {
      state.status = "Working"; state.preview = "";
      this.record(from, "state", "Working");
    } else if (event.type === "agent_settled") {
      state.status = "Ready"; state.tools.clear();
      this.record(from, "state", "Ready");
    } else if (event.type === "message_update" && event.message.role === "assistant") {
      const thinking = event.assistantMessageEvent.type.startsWith("thinking_");
      state.status = thinking ? "Thinking" : event.assistantMessageEvent.type.startsWith("toolcall_") ? "Preparing tool" : "Writing";
      state.preview = plain(event.message.content).slice(-240);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const text = plain(event.message.content);
      state.preview = text.slice(-240);
      if (text) this.record(from, "message", from === this.main ? "Reply in main transcript" : "Reply", from === this.main ? "" : text);
      if (event.message.errorMessage) this.record(from, "error", "Model error", event.message.errorMessage);
    } else if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "multiplex-letter" && from !== this.main) {
      this.record(from, "mailbox", "Messagebox · Received", plain(event.message.content));
    } else if (event.type === "tool_execution_start") {
      const label = toolLabel(event.toolName, event.args);
      state.tools.set(event.toolCallId, { label, output: "", loggedAt: 0 }); state.preview = "";
      this.record(from, "tool-start", `${label} · Started`, from === this.main ? "Details in main transcript" : toolBody(event.toolName, event.args));
    } else if (event.type === "tool_execution_update" && from !== this.main) {
      const tool = state.tools.get(event.toolCallId), output = plain(event.partialResult?.content);
      if (tool && output && output !== tool.output && Date.now() - tool.loggedAt >= 1000) {
        const delta = output.startsWith(tool.output) ? output.slice(tool.output.length) : output;
        this.record(from, "tool-output", `${tool.label} · Output`, delta);
        tool.output = output; tool.loggedAt = Date.now();
      }
    } else if (event.type === "tool_execution_end") {
      const label = state.tools.get(event.toolCallId)?.label ?? event.toolName;
      state.tools.delete(event.toolCallId); state.status = "Working";
      this.record(from, "tool-end", `${label} · ${event.isError ? "Failed" : "Finished"}`, from === this.main ? "Details in main transcript" : plain(event.result?.content));
    }
    // Tool updates keep a running row without putting approval text over the editor.
    this.refresh(event.type !== "message_update" && event.type !== "tool_execution_update");
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.states.clear();
    this.ctx.ui.setWidget(ACTIVITY_WIDGET, undefined);
  }
}
