import { textContent } from "../shared/review/protocol.ts";

type ContextEntry = {
  type: string;
  message?: { role: string; content?: unknown; toolName?: string };
  customType?: string;
  data?: unknown;
  summary?: string;
};

type Item = { source: string; text: string };

export type SideSnapshot = { text: string; included: number; omitted: number; bytes: number };

function item(entry: ContextEntry): Item | undefined {
  if (["compaction", "branch_summary"].includes(entry.type) && entry.summary)
    return { source: "parent summary", text: entry.summary };

  if (entry.type === "custom" && entry.customType === "auto-approval-operator-prompt") {
    const text = (entry.data as { text?: unknown })?.text;

    if (typeof text === "string") return { source: "operator goal", text };

  }

  const message = entry.message;

  if (
    entry.type !== "message" ||
    !message ||
    !["user", "assistant", "toolResult"].includes(message.role)
  )
    return;

  const text = textContent(message.content);
  const calls = Array.isArray(message.content)
    ? message.content
        .filter((block) => block?.type === "toolCall")
        .map((block) => JSON.stringify({ tool: block.name, arguments: block.arguments }))
        .join("\n")
    : "";
  const content = [text, calls].filter(Boolean).join("\n");

  return content
    ? {
        source:
          message.role === "toolResult"
            ? `tool result (${message.toolName ?? "unknown"})`
            : message.role,
        text: content,
      }
    : undefined;
}

/** Copy resolved parent context as inert text; never retain live session objects. */
export function sideSnapshot(entries: readonly ContextEntry[], maxBytes = 24000): SideSnapshot {
  const items = entries.map(item).filter((value): value is Item => Boolean(value));
  const chosen = new Map<number, string>();
  let bytes = 0;
  const firstUser = items.findIndex((value) => ["user", "operator goal"].includes(value.source));
  // Keep original task context plus the latest complete items; do not cut quotes
  // or tool output in half and pretend it is the complete parent conversation.
  const order = [...new Set([firstUser, ...items.map((_value, i) => i).reverse()])];

  for (const index of order) {
    if (index < 0 || chosen.size >= 40) continue;

    const serialized = JSON.stringify(items[index]);
    const size = Buffer.byteLength(serialized) + (chosen.size ? 1 : 0);

    if (bytes + size > maxBytes) continue;

    chosen.set(index, serialized);
    bytes += size;
  }

  const text = [...chosen]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value)
    .join("\n");

  return {
    text,
    included: chosen.size,
    omitted: items.length - chosen.size,
    bytes: Buffer.byteLength(text),
  };
}

