import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Text,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { UserQuestion } from "../../shared/contracts/questions.ts";

const clean = (text: string) =>
  stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

type Actions = { answer(id: string, text: string): void; dismiss(ids: string[]): void };

/** The ordinary draft is preserved separately and can never be submitted as an answer. */
export class QuestionEditor extends CustomEditor {
  private answerEditor: Editor;
  private questionId?: string;
  private selected = 0;
  private writing = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private keys: KeybindingsManager,
    private draft: string,
    private pending: () => UserQuestion[],
    private actions: Actions,
  ) {
    super(tui, theme, keys, { embedWorkingStatus: true });
    this.answerEditor = new Editor(tui, theme);
    this.answerEditor.onChange = () => tui.requestRender();
    this.answerEditor.onSubmit = (text) => {
      const question = this.current();

      if (question && text.trim()) this.actions.answer(question.id, text);
    };
    this.refresh();
  }

  getText() {
    return this.draft ?? "";
  }
  getExpandedText() {
    return this.getText();
  }
  setText(_text: string) {
    /* The SDK copies the old prompt here; retain the expanded saved draft. */
  }

  refresh() {
    this.current();
    this.tui.requestRender();
  }

  private current() {
    const question = this.pending()[0];

    if (question?.id !== this.questionId) {
      this.questionId = question?.id;
      this.selected = 0;
      this.writing = !question?.options?.length;
      this.answerEditor.setText("");
    }

    return question;
  }

  private choices(question: UserQuestion) {
    return [
      ...(question.options ?? []).map((option) => ({
        label: option.label,
        description: option.description,
        answer: option.label,
      })),
      { label: "Write an answer", description: undefined, answer: undefined },
      { label: "Discard question", description: undefined, answer: undefined },
      ...(this.pending().length > 1
        ? [{ label: "Discard all questions", description: undefined, answer: undefined }]
        : []),
    ];
  }

  handleInput(data: string) {
    const question = this.current();

    if (this.keys.matches(data, "app.interrupt")) {
      super.handleInput(data);

      return;
    }

    if (this.keys.matches(data, "app.exit")) {
      (this.onCtrlD ?? this.actionHandlers.get("app.exit"))?.();

      return;
    }

    if (this.keys.matches(data, "app.tools.expand")) {
      this.actionHandlers.get("app.tools.expand")?.();

      return;
    }

    if (!question) return;

    if (matchesKey(data, "ctrl+x")) {
      this.actions.dismiss([question.id]);

      return;
    }

    if (matchesKey(data, "ctrl+c")) {
      this.answerEditor.setText("");

      return;
    }

    if (matchesKey(data, "tab")) {
      this.writing = !this.writing;
      this.tui.requestRender();

      return;
    }

    if (this.writing) {
      this.answerEditor.handleInput(data);

      return;
    }

    const choices = this.choices(question);

    this.selected = Math.min(this.selected, choices.length - 1);

    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.selected =
        (this.selected + (matchesKey(data, "up") ? -1 : 1) + choices.length) % choices.length;
    } else if (this.keys.matches(data, "tui.input.submit")) {
      const choice = choices[this.selected];

      if (choice.answer !== undefined) this.actions.answer(question.id, choice.answer);
      else if (this.selected === (question.options?.length ?? 0)) this.writing = true;
      else
        this.actions.dismiss(
          this.selected === choices.length - 1 && this.pending().length > 1
            ? this.pending().map((item) => item.id)
            : [question.id],
        );
    } else {
      this.writing = true;
      this.answerEditor.handleInput(data);
    }

    this.tui.requestRender();
  }

  render(width: number): string[] {
    const question = this.current();

    if (!question) return [];

    const lines = [
      this.renderTopBorder(width, 0),
      `Question · ${clean(question.owner)} · ${this.pending().length} pending · ${clean(question.header)}`,
    ];
    const wrapped = new Text(clean(question.question), 0, 0).render(Math.max(1, width));

    lines.push(...wrapped.slice(0, 4));

    if (wrapped.length > 4) lines.push("… full question is in the activity log");

    if (this.writing) {
      this.answerEditor.focused = this.focused;
      lines.push(...this.answerEditor.render(width));
    } else {
      lines.push(
        ...this.choices(question).map(
          (choice, index) =>
            `${index === this.selected ? "›" : " "} ${clean(choice.label)}${choice.description ? ` — ${clean(choice.description)}` : ""}`,
        ),
      );
    }

    lines.push(
      "Enter: answer · Tab: text/choices · Ctrl+X: discard · Ctrl+O: log · Esc: interrupt",
    );

    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate() {
    super.invalidate();
    this.answerEditor.invalidate();
  }
}
