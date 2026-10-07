import { stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";

type Node = Component & { children?: Component[]; updateContent?: unknown; setHideThinkingBlock?: unknown; lastMessage?: unknown; entry?: { customType?: string } };
type Binding = { original: Component["render"]; wrapped: Component["render"] };

/** Collapse only empty native rows replaced by the feed; preserve visible spacing. */
export class TranscriptSpacing {
  private generation = 0;
  private bindings = new Map<Node, Binding>();
  constructor(private hidesMessage: (message: unknown) => boolean) {}
  bind(ui: TUI) {
    const document = ui.children?.[0] as Node | undefined;
    if (!document || !Array.isArray(document.children) || this.bindings.has(document)) return;
    const original = document.render, spacing = this, generation = this.generation;
    const wrapped = function(this: Node, width: number) {
      if (generation === spacing.generation) spacing.scan(this);
      return original.call(this, width);
    };
    this.bindings.set(document, { original, wrapped });
    document.render = wrapped;
  }
  private scan(node: Node) {
    // Inspect component shape because compiled Pi and extensions have separate
    // SDK class identities. Unknown host layouts keep their original rendering.
    const assistant = typeof node.updateContent === "function" && typeof node.setHideThinkingBlock === "function";
    const feedEntry = ["multiplex-feed", "multiplex-activity"].includes(node.entry?.customType ?? "");
    if (assistant || feedEntry) {
      if (this.bindings.has(node)) return;
      const original = node.render, spacing = this, generation = this.generation;
      const wrapped = function(this: Node, width: number) {
        const lines = original.call(this, width);
        const owned = feedEntry || spacing.hidesMessage(this.lastMessage);
        return generation === spacing.generation && owned && lines.every((line) => !stripTerminalSequences(line).trim()) ? [] : lines;
      };
      this.bindings.set(node, { original, wrapped });
      node.render = wrapped;
      return;
    }
    if (Array.isArray(node.children)) for (const child of node.children) this.scan(child as Node);
  }
  dispose() {
    this.generation++;
    for (const [node, { original, wrapped }] of this.bindings) if (node.render === wrapped) node.render = original;
    this.bindings.clear();
  }
}
