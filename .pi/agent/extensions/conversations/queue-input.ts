import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorComponent } from "@earendil-works/pi-tui";

type QueueEditor = EditorComponent & {
  actionHandlers?: Map<string, () => void>;
  isShowingAutocomplete?: () => boolean;
};

/** Reuse Pi's native follow-up action, including history, expanded drafts and pending-message UI. */
export function queueInput(editor: QueueEditor, busy: () => boolean, data: string): boolean {
  if (!busy()) return false;

  const queue = editor.actionHandlers?.get("app.message.followUp");

  if (!queue || !matchesKey(data, "tab") || editor.isShowingAutocomplete?.()) return false;

  if (!(editor.getExpandedText?.() ?? editor.getText()).trim()) return false;

  queue();

  return true;
}

/** QuestionController temporarily replaces this normal composer and restores it after answers. */
export function installQueueEditor(ctx: ExtensionContext): () => void {
  if (
    ctx.mode !== "tui" ||
    typeof ctx.ui.getEditorComponent !== "function" ||
    typeof ctx.ui.setEditorComponent !== "function"
  )
    return () => {};

  const previous = ctx.ui.getEditorComponent();
  let editor: QueueEditor | undefined;
  let original: QueueEditor["handleInput"] | undefined;
  let wrapped: QueueEditor["handleInput"] | undefined;
  let active = true;
  const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui, theme, keys) => {
    if (editor) return editor;

    editor = (previous?.(tui, theme, keys) ??
      new CustomEditor(tui, theme, keys, { embedWorkingStatus: true })) as QueueEditor;

    const target = editor;

    original = target.handleInput;

    const handle = original.bind(target);

    wrapped = (data) => {
      if (active && queueInput(target, () => !ctx.isIdle(), data)) return;

      const complete =
        active &&
        target.actionHandlers?.has("app.message.followUp") &&
        !ctx.isIdle() &&
        matchesKey(data, "shift+tab");

      handle(complete ? "\t" : data);
    };
    target.handleInput = wrapped;

    return target;
  };

  ctx.ui.setEditorComponent(factory);

  return () => {
    active = false;

    if (editor && original && editor.handleInput === wrapped) editor.handleInput = original;

    if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
  };
}
