import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { getEditorTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { expect, test } from "bun:test";
import { CustomEditor, initTheme } from "@earendil-works/pi-coding-agent";
import { installQueueEditor, queueInput } from "../../conversations/queue-input.ts";

function fixture() {
  initTheme("dark", false);

  let busy = true,
    count = 0;
  const tui: any = { terminal: { rows: 30, columns: 80 }, requestRender() {} };
  const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());

  editor.setText("Do the next task after this reply.");
  editor.onAction("app.message.followUp", () => {
    count++;
  });

  return {
    editor,
    count: () => count,
    busy: () => busy,
    idle: () => {
      busy = false;
    },
  };
}

test("Tab uses the native follow-up action once for both legacy and Kitty input", () => {
  for (const data of ["\t", "\x1b[9u"]) {
    const state = fixture();

    expect(queueInput(state.editor, state.busy, data)).toBe(true);
    expect(state.count()).toBe(1);
    expect(state.editor.getText()).toBe("Do the next task after this reply.");
  }
});

test("idle, empty, completion menus and unrelated keys retain normal editor handling", () => {
  const state = fixture();

  for (const data of ["\r", "\x1b", "\x03", "ordinary text"])
    expect(queueInput(state.editor, state.busy, data)).toBe(false);

  state.editor.setText(" \n ");
  expect(queueInput(state.editor, state.busy, "\t")).toBe(false);
  state.editor.setText("A new task");
  state.editor.isShowingAutocomplete = () => true;
  expect(queueInput(state.editor, state.busy, "\t")).toBe(false);
  state.editor.isShowingAutocomplete = () => false;
  state.idle();
  expect(queueInput(state.editor, state.busy, "\t")).toBe(false);
  expect(state.count()).toBe(0);
});

test("expanded drafts are recognized without rewriting them or swallowing missing handlers", () => {
  const state = fixture();

  state.editor.setText("");
  state.editor.getExpandedText = () => "Expanded pasted input";
  expect(queueInput(state.editor, state.busy, "\t")).toBe(true);
  state.editor.actionHandlers.clear();
  expect(queueInput(state.editor, state.busy, "\t")).toBe(false);
});

test("the composer preserves an existing editor and restores it without stacking wrappers", () => {
  const state = fixture();
  const inputs: string[] = [];

  state.editor.handleInput = (data) => {
    inputs.push(data);
  };

  const originalHandler = state.editor.handleInput;

  state.editor.addToHistory("Earlier prompt");

  const original = () => state.editor;
  let current: any = original;
  const ctx: any = {
    mode: "tui",
    isIdle: () => false,
    ui: {
      getEditorComponent: () => current,
      setEditorComponent: (value: any) => {
        current = value;
      },
    },
  };
  const restore = installQueueEditor(ctx);
  const editor = current({}, {}, {});

  editor.handleInput("\t");
  expect(state.count()).toBe(1);
  editor.handleInput("\x1b[Z");
  expect(inputs).toEqual(["\t"]);
  expect(current({}, {}, {})).toBe(editor);
  restore();
  expect(current).toBe(original);
  expect(editor.handleInput).toBe(originalHandler);
  editor.handleInput("\t");
  expect(state.count()).toBe(1);
});

test("headless and RPC contexts install no terminal editor", () => {
  for (const mode of ["rpc", "print"]) {
    let changed = false;
    const restore = installQueueEditor({
      mode,
      ui: {
        setEditorComponent() {
          changed = true;
        },
      },
    } as any);

    restore();
    expect(changed).toBe(false);
  }
});
