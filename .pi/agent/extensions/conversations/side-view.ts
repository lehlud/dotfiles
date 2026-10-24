import {
  Editor,
  CURSOR_MARKER,
  Markdown,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  getMarkdownTheme,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { SideConversation } from "./side-conversation.ts";
import { sessionServices } from "../shared/session/services.ts";

const clean = (text: string) =>
  stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

export class SideView {
  readonly conversation: SideConversation;
  readonly editor: Editor;
  private scroll = 0;
  private notice = "";
  private disposed = false;
  private focusedValue = false;
  private readonly ownsInterrupt = () => this.focusedValue && !this.disposed;
  constructor(
    private tui: TUI,
    private theme: Theme,
    private ctx: ExtensionCommandContext,
    private done: () => void,
    initial: string,
  ) {
    this.conversation = new SideConversation(ctx, () => this.update());
    this.editor = new Editor(tui, {
      borderColor: (value) => theme.fg("accent", value),
      selectList: {
        selectedPrefix: (value) => theme.fg("accent", value),
        selectedText: (value) => theme.fg("accent", value),
        description: (value) => theme.fg("dim", value),
        scrollInfo: (value) => theme.fg("dim", value),
        noMatch: (value) => theme.fg("warning", value),
      },
    });
    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };

    this.editor.onChange = () => tui.requestRender();
    sessionServices(ctx).terminalInterruptOwned = this.ownsInterrupt;
    this.update();

    if (initial.trim())
      queueMicrotask(() => {
        void this.submit(initial);
      });
  }

  get focused() {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.editor.focused = value;
  }

  private update() {
    if (this.disposed) return;

    this.ctx.ui.setStatus("01-side", `side: ${this.conversation.busy ? "responding" : "open"}`);
    this.tui.requestRender();
  }

  private async submit(text: string) {
    if (this.disposed) return;

    if (["/back", "/exit", "/close"].includes(text.trim())) {
      this.done();

      return;
    }

    if (/^\/side(?:\s|$)/.test(text.trim())) {
      this.editor.setText(text);
      this.notice = "A side chat cannot open another side chat.";
      this.update();

      return;
    }

    if (this.conversation.busy) {
      this.editor.setText(text);
      this.notice = "The side request is still running. Escape cancels only this request.";
      this.update();

      return;
    }

    if (text.trim() === "/new") {
      this.conversation.reset();
      this.notice = "";
      this.scroll = 0;
      this.update();

      return;
    }

    this.notice = "";
    this.scroll = 0;

    try {
      await this.conversation.ask(text);
    } catch (error) {
      // Editor clears on submit. Restore rejected input, preserving any newer draft.
      if (!this.disposed && !this.editor.getText()) this.editor.setText(text);

      this.notice = error instanceof Error ? error.message : "Could not start the side question.";
    }

    this.update();
  }

  handleInput(data: string) {
    if (this.disposed) return;

    if (matchesKey(data, "ctrl+c")) {
      this.done();

      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.conversation.busy) this.conversation.cancel();
      else this.done();

      return;
    }

    if (matchesKey(data, "pageUp")) {
      this.scroll += 8;
      this.tui.requestRender();

      return;
    }

    if (matchesKey(data, "pageDown")) {
      this.scroll = Math.max(0, this.scroll - 8);
      this.tui.requestRender();

      return;
    }

    this.editor.handleInput(data);
  }

  invalidate() {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
    const parent = this.ctx.isIdle() ? "ready" : "still working";
    const snapshot = this.conversation.snapshot;
    const title = `Side chat · Main conversation ${parent} · ${this.conversation.model.id}`;
    const info = `${snapshot.included} context items, ${snapshot.omitted} omitted · ${this.conversation.tokens} tokens · $${this.conversation.cost.toFixed(4)}`;
    const header = [this.theme.fg("accent", title), this.theme.fg("dim", info)];
    const body: string[] = [];

    for (const turn of this.conversation.turns) {
      body.push(
        ...new Markdown(`**You:**\n${clean(turn.question)}`, 0, 0, getMarkdownTheme()).render(
          width,
        ),
      );

      if (turn.answer || !turn.error)
        body.push(
          ...new Markdown(clean(turn.answer || "…"), 0, 0, getMarkdownTheme()).render(width),
        );

      if (turn.error) body.push(this.theme.fg("warning", turn.error));

      if (turn.truncated)
        body.push(
          this.theme.fg(
            "warning",
            "Response truncated at the output limit; you can ask a follow-up question.",
          ),
        );

      body.push("");
    }

    if (!body.length) body.push("Ask a question about the main conversation context.");

    // Reserve the composer before optional headers/history. Keep the focused row
    // when Pi's editor is taller than this overlay, including after a resize.
    const headerRows = header.slice(0, Math.max(0, height - 4));
    const editor = this.editorLines(width, Math.max(1, height - headerRows.length - 1));
    const hint =
      this.notice ||
      (this.conversation.busy
        ? "Escape: cancel side request · Ctrl+C: return"
        : "Enter: ask · Escape: return · PgUp/PgDn: history");
    const room = Math.max(0, height - headerRows.length - editor.length - 1);

    this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));

    const end = Math.max(0, body.length - this.scroll);

    return [
      ...headerRows,
      ...body.slice(Math.max(0, end - room), end),
      ...editor,
      this.theme.fg("dim", hint),
    ]
      .slice(0, height)
      .map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  private editorLines(width: number, height: number): string[] {
    const lines = this.editor.render(width);

    if (lines.length <= height) return lines;

    const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = Math.max(0, Math.min(cursor < 0 ? 0 : cursor - 1, lines.length - height));

    return lines.slice(start, start + height);
  }

  dispose() {
    if (this.disposed) return;

    this.disposed = true;
    this.conversation.close();

    const services = sessionServices(this.ctx);

    if (services.terminalInterruptOwned === this.ownsInterrupt)
      services.terminalInterruptOwned = undefined;

    this.ctx.ui.setStatus("01-side", undefined);
  }
}
