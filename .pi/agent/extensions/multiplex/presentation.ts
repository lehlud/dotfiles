import {
  Container,
  Text,
  parseColor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { TranscriptSpacing } from "./transcript-spacing.ts";
import type { ActivityRecord } from "./activity.ts";

export const AGENT_COLORS = [
  "#63b3ed",
  "#f6ad55",
  "#b794f4",
  "#68d391",
  "#f687b3",
  "#4fd1c5",
  "#fc8181",
  "#d6bcfa",
  "#90cdf4",
  "#faf089",
  "#9ae6b4",
  "#fbb6ce",
  "#81e6d9",
  "#7c9cf5",
  "#fbd38d",
  "#a0aec0",
] as const;
export const clean = (value: string) =>
  stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export const colorize = (theme: Theme, index: number, text: string) =>
  theme.style(text, {
    fg: parseColor(AGENT_COLORS[index % AGENT_COLORS.length] ?? AGENT_COLORS[0]),
  });
export const empty = (): Component => new Container();

/** Filtering is a local display choice, never a conversation or routing change. */
export class FeedView {
  selected?: string;
  private ui?: TUI;
  private spacing = new TranscriptSpacing((message) => this.hidesMessage(message));
  private nativeTools = new Set<string>();
  private nativeTexts = new Set<string>();
  private streamingTexts = new Set<string>();
  private segments = new Map<string, ActivityRecord[]>();
  records(segment: string) {
    return this.segments.get(segment) ?? [];
  }
  append(record: ActivityRecord) {
    if (!record.segment) return;
    const records = this.segments.get(record.segment) ?? [];
    records.push(record);
    this.segments.set(record.segment, records);
  }
  private digest(text: string) {
    return createHash("sha256").update(text.trim()).digest("hex");
  }
  rootText(blocks: any[], finalized = false) {
    const hashes = blocks.flatMap((block) =>
      block.type === "text"
        ? [this.digest(block.text)]
        : block.type === "thinking"
          ? [this.digest(block.thinking)]
          : [],
    );
    this.streamingTexts = new Set(hashes);
    if (finalized) for (const hash of hashes) this.nativeTexts.add(hash);
    return hashes;
  }
  rootTool(id: string) {
    this.nativeTools.add(id);
  }
  hidesTool(id: string) {
    return this.nativeTools.has(id);
  }
  hidesText(text: string) {
    const hash = this.digest(text);
    return this.nativeTexts.has(hash) || this.streamingTexts.has(hash);
  }
  restore(records: ActivityRecord[]) {
    this.spacing.dispose();
    if (this.ui) this.spacing.bind(this.ui);
    this.nativeTools.clear();
    this.nativeTexts.clear();
    this.streamingTexts.clear();
    this.segments.clear();
    for (const record of records)
      if (record) {
        this.append(record);
        if (record.backend) {
          if (record.toolCallId) this.rootTool(record.toolCallId);
          for (const hash of record.nativeTexts ?? []) this.nativeTexts.add(hash);
        }
      }
  }
  private hidesMessage(message: any) {
    if (!Array.isArray(message?.content)) return false;
    const blocks = message.content.flatMap((block: any) =>
      block.type === "text" ? [block.text] : block.type === "thinking" ? [block.thinking] : [],
    );
    return (
      blocks.some((text: unknown) => typeof text === "string" && text.trim()) &&
      blocks.every(
        (text: unknown) => typeof text === "string" && (!text.trim() || this.hidesText(text)),
      )
    );
  }
  bind(ui: TUI) {
    this.ui = ui;
    this.spacing.bind(ui);
  }
  dispose() {
    this.spacing.dispose();
    this.ui = undefined;
  }
  accepts(name: string) {
    return !this.selected || this.selected === name;
  }
  select(name?: string) {
    this.selected = name;
    this.ui?.invalidate?.();
    this.ui?.requestRender?.(true);
  }
  filter(name: string, component: Component): Component {
    return {
      render: (width) => (this.accepts(name) ? component.render(width) : []),
      invalidate: () => component.invalidate(),
    };
  }
  refresh() {
    this.ui?.invalidate?.();
    this.ui?.requestRender?.();
  }
}

export function messageBody(text: string, expanded: boolean) {
  const body = clean(text),
    lines = body.split("\n");
  if (expanded) return body;
  const preview = lines
    .slice(0, 5)
    .map((line) => truncateToWidth(line, 180))
    .join("\n");
  return (
    preview +
    (lines.length > 5 || lines.some((line) => visibleWidth(line) > 180)
      ? "\n[ctrl+o to expand]"
      : "")
  );
}

export function mailboxRenderers(): ToolRenderers {
  return {
    renderShell: "self",
    renderCall: () => empty(),
    renderResult(result, options, theme, context) {
      if (context.isError)
        return new Text(
          theme.fg(
            "error",
            result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          ),
          0,
          0,
        );
      const args = context.args as any,
        details = result.details as any;
      // Successful sends have one broker entry; inbox reads do not replay letters.
      if (args?.operation === "send") return empty();
      const text = ["plan", "accept", "withdraw"].includes(args?.operation)
        ? `Coordination · ${details?.ready ? "Ready" : "Planning"}
${details?.assignments?.map((item: any) => `${item.name}: ${item.task}${item.waiting ? " (waiting)" : ""}`).join("\n") ?? "No work split"}`
        : args?.operation === "peers"
          ? `Messagebox · Members\n${details?.members?.join(", ") ?? ""}`
          : `Messagebox · Inbox · ${Array.isArray(details) ? details.length : 0} messages`;
      return new Text(messageBody(text, options.expanded), 0, 0);
    },
  };
}

export function suppressNativeFeed(pi: ExtensionAPI, view: FeedView, active: () => boolean) {
  // Custom activity entries replace the backend session's native tool rows.
  pi.registerToolRenderer((_name, next) => {
    const original = next();
    if (!original && !active()) return;
    const hidden = (context: any) =>
      (context.state.multiplexHidden ||= active() || view.hidesTool(context.toolCallId));
    return {
      ...original,
      renderShell: "self",
      renderCall: (args, theme, context) =>
        hidden(context)
          ? empty()
          : (original?.renderCall?.(args, theme, context) ?? new Text(String(_name), 0, 0)),
      renderResult: (result, options, theme, context) =>
        hidden(context)
          ? empty()
          : (original?.renderResult?.(result, options, theme, context) ??
            new Text(
              result.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
              0,
              0,
            )),
    };
  });
  pi.registerMarkdownTransformer((text, context) =>
    context.messageType !== "user" && view.hidesText(text) ? "" : text,
  );
  pi.registerMessageRenderer("multiplex-letter", () => empty());
}
