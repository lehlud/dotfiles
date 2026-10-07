import { Editor, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { SideConversation } from "./side-conversation.ts";

const clean = (text: string) => stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
export class SideView {
  readonly conversation: SideConversation;
  readonly editor: Editor;
  private scroll = 0;
  private notice = "";
  private disposed = false;
  private focusedValue = false;
  constructor(private tui: TUI, private theme: Theme, private ctx: ExtensionCommandContext, private done: () => void, initial: string) {
    this.conversation = new SideConversation(ctx, () => this.update());
    this.editor = new Editor(tui, { borderColor: (value) => theme.fg("accent", value), selectList: { selectedPrefix: (value) => theme.fg("accent", value), selectedText: (value) => theme.fg("accent", value), description: (value) => theme.fg("dim", value), scrollInfo: (value) => theme.fg("dim", value), noMatch: (value) => theme.fg("warning", value) } });
    this.editor.onSubmit = (text) => { this.editor.setText(""); void this.submit(text); };
    this.editor.onChange = () => tui.requestRender();
    this.update();
    if (initial.trim()) queueMicrotask(() => { void this.submit(initial); });
  }
  get focused() { return this.focusedValue; }
  set focused(value: boolean) { this.focusedValue = value; this.editor.focused = value; }
  private update() {
    if (this.disposed) return;
    this.ctx.ui.setStatus("01-side", `side: ${this.conversation.busy ? "responding" : "open"}`);
    this.tui.requestRender();
  }
  private async submit(text: string) {
    if (this.disposed) return;
    if (["/back", "/exit", "/close"].includes(text.trim())) { this.done(); return; }
    if (text.trim().startsWith("/side")) { this.notice = "A side chat cannot open another side chat."; this.update(); return; }
    if (this.conversation.busy) { this.notice = "The side request is still running. Escape cancels only this request."; this.update(); return; }
    if (text.trim() === "/new") { this.conversation.reset(); this.notice = ""; this.scroll = 0; this.update(); return; }
    this.notice = ""; this.scroll = 0;
    try { await this.conversation.ask(text); }
    catch (error) { this.notice = error instanceof Error ? error.message : "Could not start the side question."; }
    this.update();
  }
  handleInput(data: string) {
    if (matchesKey(data, "ctrl+c")) { this.done(); return; }
    if (matchesKey(data, "escape")) { if (this.conversation.busy) this.conversation.cancel(); else this.done(); return; }
    if (matchesKey(data, "pageUp")) { this.scroll += 8; this.tui.requestRender(); return; }
    if (matchesKey(data, "pageDown")) { this.scroll = Math.max(0, this.scroll - 8); this.tui.requestRender(); return; }
    this.editor.handleInput(data);
  }
  invalidate() { this.editor.invalidate(); }
  render(width: number): string[] {
    const height = Math.max(1, Math.min(this.tui.terminal.rows - 5, Math.floor(this.tui.terminal.rows * 0.8)));
    const parent = this.ctx.isIdle() ? "ready" : "still working";
    const snapshot = this.conversation.snapshot;
    const title = `Side chat · Main conversation ${parent} · ${this.conversation.model.id}`;
    const info = `${snapshot.included} context items, ${snapshot.omitted} omitted · ${this.conversation.tokens} tokens · $${this.conversation.cost.toFixed(4)}`;
    const header = [this.theme.fg("accent", title), this.theme.fg("dim", info)];
    const body: string[] = [];
    for (const turn of this.conversation.turns) {
      body.push(...new Markdown(`**You:**\n${clean(turn.question)}`, 0, 0, getMarkdownTheme()).render(width));
      body.push(...new Markdown(clean(turn.answer || "…"), 0, 0, getMarkdownTheme()).render(width));
      if (turn.error) body.push(this.theme.fg("warning", turn.error));
      if (turn.truncated) body.push(this.theme.fg("warning", "Response truncated at the output limit; you can ask a follow-up question."));
      body.push("");
    }
    if (!body.length) body.push("Ask a question about the main conversation context.");
    const editor = this.editor.render(width).slice(-Math.max(1, height - 3));
    const hint = this.notice || (this.conversation.busy ? "Escape: cancel side request · Ctrl+C: return" : "Enter: ask · Escape: return · PgUp/PgDn: history");
    const room = Math.max(0, height - header.length - editor.length - 1);
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));
    const end = Math.max(0, body.length - this.scroll);
    return [...header, ...body.slice(Math.max(0, end - room), end), ...editor, this.theme.fg("dim", hint)].slice(0, height).map((line) => truncateToWidth(line, Math.max(1, width)));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.conversation.close(); this.ctx.ui.setStatus("01-side", undefined);
  }
}
