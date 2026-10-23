import { Check } from "typebox/value";
import { bindPeerQuestions } from "../../conversations/questions/tools.ts";
import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth, Editor } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  initTheme,
  getEditorTheme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { QuestionStore, QUESTION_ENTRY } from "../../conversations/questions/store.ts";
import { QuestionEditor } from "../../conversations/questions/editor.ts";
import { installQueueEditor } from "../../conversations/queue-input.ts";
import { registerQuestions } from "../../conversations/questions/index.ts";
import { registerOperatorInputs } from "../../conversations/operator-input.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { operatorPromptRecords } from "../../shared/review/prompts.ts";
import { reviewLanguageReference } from "../../shared/review/context.ts";
import type { QuestionInput } from "../../shared/contracts/questions.ts";

const input: QuestionInput = {
  header: "Runtime",
  question: "Which runtime should the client target?",
  options: [
    { label: "Web", description: "Browser client" },
    { label: "Desktop", description: "Native client" },
  ],
};

function fixture(mode = "tui", queue = false) {
  initTheme("dark", false);

  const entries: any[] = [
    {
      id: "original",
      type: "message",
      message: { role: "user", content: "Implement the client." },
    },
  ];
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  const notices: string[] = [];
  const broadcast: string[] = [];
  const statuses = new Map<string, string>();
  let editor: any;
  let factory: any;
  let draft = "An unfinished prompt draft";
  let failJournal = false;
  const tui: any = { terminal: { rows: 30, columns: 80 }, requestRender() {} };
  const ctx: any = {
    mode,
    isIdle: () => false,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus: (key: string, text?: string) =>
        text ? statuses.set(key, text) : statuses.delete(key),
      notify: (text: string) => notices.push(text),
      getEditorText: () => editor?.getExpandedText?.() ?? draft,
      getEditorComponent: () => factory,
      setEditorComponent: (next: any) => {
        const current = editor?.getText() ?? draft;

        factory = next;
        editor = next?.(tui, getEditorTheme(), new KeybindingsManager());

        if (editor) {
          // The real Pi UI overwrites onSubmit and copies the existing prompt after construction.
          editor.onSubmit = (text: string) => sent.push({ forbiddenPrompt: text });
          editor.setText(current);
        } else draft = current;
      },
    },
  };
  const api: any = {
    on: (name: string, callback: Function) =>
      hooks.set(name, [...(hooks.get(name) ?? []), callback]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => {
      if (failJournal) throw new Error("Question journal unavailable");

      entries.push({ id: `entry-${entries.length}`, type: "custom", customType, data });
    },
    sendUserMessage: (text: string, options: unknown) => {
      sent.push({ text, options });
      entries.push({
        id: `answer-${entries.length}`,
        type: "message",
        message: { role: "user", content: text },
      });
    },
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  };
  const fire = (name: string, event = {}) => {
    for (const hook of hooks.get(name) ?? []) {
      const result = hook(event, ctx);

      if (result?.action === "handled") return result;
    }
  };

  registerQuestions(api, queue ? installQueueEditor : undefined);
  registerOperatorInputs(api);
  fire("session_start");
  sessionServices(ctx).broadcastOperatorInput = (text) => broadcast.push(text);
  sessionServices(ctx).broadcastConversationMessage = (_type, text) => broadcast.push(text);

  return {
    ctx,
    entries,
    sent,
    notices,
    broadcast,
    statuses,
    tools,
    commands,
    fire,
    tui,
    editor: () => editor as QuestionEditor,
    factory: () => factory,
    draft: () => editor?.getText() ?? draft,
    client: (owner = "agent") => sessionServices(ctx).questions!(owner),
    failJournal: () => {
      failJournal = true;
    },
  };
}

test("question transitions are journaled, clone isolated, deduplicated and restored", () => {
  const events: any[] = [];
  const store = new QuestionStore((event) => events.push(event));
  const [first] = store.ask("maple", [input]);

  first.question = "Mutated result";
  expect(store.list()[0].question).toBe(input.question);
  expect(store.ask("maple", [input])[0].id).toBe(first.id);
  expect(events).toHaveLength(1);
  store.resolve([first.id], "answered", "Web");

  const restored = new QuestionStore(() => {});

  restored.restore([
    ...events,
    { operation: "answered", ids: [first.id], answer: "forged late change" },
  ]);
  expect(restored.list()[0]).toMatchObject({ status: "answered", answer: "Web" });
  expect(restored.pending()).toEqual([]);
});

test("ownership, pending limits and atomic persistence prevent forged or partial transitions", () => {
  const store = new QuestionStore(() => {});
  const [first] = store.ask("maple", [input]);

  expect(() => store.resolve([first.id], "withdrawn", undefined, "brook")).toThrow(
    "Unknown question",
  );
  expect(() => store.resolve([first.id, "missing"], "dismissed")).toThrow();
  expect(store.pending()).toHaveLength(1);

  for (let index = 0; index < 11; index++)
    store.ask("maple", [{ ...input, question: `Question ${index}` }]);

  expect(() => store.ask("maple", [{ ...input, question: "Too many" }])).toThrow(
    "Resolve or withdraw",
  );
  expect(store.ask("maple", [input])[0].id).toBe(first.id);
  expect(() =>
    new QuestionStore(() => {
      throw new Error("Journal failed");
    }).ask("maple", [input]),
  ).toThrow("Journal failed");
  expect(() => store.resolve([first.id], "answered", " ")).toThrow("Provide an answer");
});

test("asking returns immediately and replaces the prompt until choice submission restores its draft", () => {
  const state = fixture();
  const [question] = state.client("maple").ask([input]);

  expect(state.editor()).toBeInstanceOf(QuestionEditor);
  expect(state.statuses.get("questions")).toBe("questions: 1");
  expect(state.draft()).toBe("An unfinished prompt draft");
  expect(state.fire("input", { text: "An unrelated new prompt", source: "interactive" })).toEqual({
    action: "handled",
  });
  state.editor().handleInput("\r");
  expect(state.factory()).toBeUndefined();
  expect(state.draft()).toBe("An unfinished prompt draft");
  expect(state.client("maple").list()[0]).toMatchObject({
    id: question.id,
    status: "answered",
    answer: "Web",
  });
  expect(state.sent).toHaveLength(1);
  expect(state.sent[0].forbiddenPrompt).toBeUndefined();
  expect(state.sent[0].options).toEqual({ deliverAs: "steer", expandPromptTemplates: false });
  expect(state.broadcast).toEqual([state.sent[0].text]);
  sessionServices(state.ctx).flushOperatorInputs!();
  expect(operatorPromptRecords(state.entries).at(-1)?.kind).toBe("steering");
});

test("free-text answers do not run slash commands or replace the answer language with UI boilerplate", () => {
  const state = fixture();

  state
    .client()
    .ask([{ header: "Language", question: "Which language should the interface use?" }]);
  state.editor().handleInput("Deutsch");
  state.editor().handleInput("\r");
  expect(state.sent[0].text).toContain("\n\nDeutsch");
  expect(reviewLanguageReference(state.sent[0].text)).toBe("Deutsch");
  expect(state.sent[0].options.expandPromptTemplates).toBe(false);
  expect(state.draft()).toBe("An unfinished prompt draft");
});

test("user dismissal and model withdrawal are distinct and neither invents an operator answer", () => {
  const state = fixture();
  const [first, second] = state.client().ask([input, { ...input, question: "Choose a layout?" }]);

  state.editor().handleInput("\x18");
  expect(state.client().list()[0]).toMatchObject({ id: first.id, status: "dismissed" });
  expect(state.sent[0].message.customType).toBe("question-dismissed");
  expect(state.sent[0].message.content).toContain("No answer or additional permission");
  expect(state.factory()).toBeDefined();
  state.client().withdraw([second.id]);
  expect(state.factory()).toBeUndefined();
  expect(state.sent).toHaveLength(1);
  expect(state.client().list()[1].status).toBe("withdrawn");
  expect(state.draft()).toBe("An unfinished prompt draft");
});

test("withdrawal removes stale answer text, and old editors cannot answer a new session", () => {
  const state = fixture();
  const owner = state.client();
  const [first] = owner.ask([{ header: "First", question: "First question?" }]);
  const oldEditor = state.editor();

  oldEditor.handleInput("old text");
  owner.ask([{ header: "Second", question: "Second question?" }]);
  owner.withdraw([first.id]);
  state.editor().handleInput("new text");
  state.editor().handleInput("\r");
  expect(state.sent[0].text).toContain("\n\nnew text");
  expect(state.sent[0].text).not.toContain("old text");
  state.entries.splice(0);
  state.fire("session_tree");
  expect(() => owner.list()).toThrow("no longer active");
  oldEditor.handleInput("stale answer\r");
  expect(state.sent).toHaveLength(1);
});

test("pending questions survive reload and session changes do not leak their clients or panel", () => {
  const state = fixture();
  const [question] = state.client().ask([input]);

  state.fire("session_shutdown");
  expect(state.factory()).toBeUndefined();
  expect(sessionServices(state.ctx).questions).toBeUndefined();
  state.fire("session_start");
  expect(state.client().list()[0].id).toBe(question.id);
  expect(state.factory()).toBeDefined();
  state.entries.splice(0);
  state.fire("session_tree");
  expect(state.client().list()).toEqual([]);
  expect(state.factory()).toBeUndefined();
});

test("a failed question journal does not expose a new prompt or lose a pending answer", () => {
  const state = fixture();
  const [question] = state.client().ask([input]);

  state.failJournal();
  state.editor().handleInput("\r");
  expect(state.client().list()[0].status).toBe("pending");
  expect(state.sent).toEqual([]);
  expect(state.factory()).toBeDefined();
  expect(state.notices.at(-1)).toContain("Question journal unavailable");
  expect(() => state.client().withdraw([question.id])).toThrow("journal");
});

test("question controls render compactly, preserve interrupt and reject unsupported tool capabilities", async () => {
  const state = fixture();
  let interrupts = 0;

  state.client().ask([input]);
  state.editor().onEscape = () => {
    interrupts++;
  };
  state.editor().handleInput("\x1b");
  expect(interrupts).toBe(1);

  for (const width of [28, 80]) {
    const lines = state.editor().render(width).map(stripTerminalSequences);

    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.length).toBeLessThan(22);
  }

  const aborted = new AbortController();

  aborted.abort();
  await expect(
    state.tools
      .get("ask_user")
      .execute("ask", { questions: [input] }, aborted.signal, undefined, state.ctx),
  ).rejects.toThrow();
  await expect(
    state.tools
      .get("user_questions")
      .execute("withdraw", { operation: "withdraw" }, undefined, undefined, state.ctx),
  ).rejects.toThrow("requires question IDs");
  expect(state.entries.filter((entry) => entry.customType === QUESTION_ENTRY)).toHaveLength(1);
});

test("the command interface supports headless answers and discard-all without opening a TUI", async () => {
  const state = fixture("rpc");
  const [first] = state.client().ask([input]);
  const command = state.commands.get("questions").handler;

  expect(state.factory()).toBeUndefined();
  await command(`answer ${first.id} Web`, state.ctx);
  expect(state.client().list()[0].answer).toBe("Web");
  state.client().ask([input, { ...input, question: "Another?" }]);
  await command("discard all", state.ctx);
  expect(
    state
      .client()
      .list()
      .filter((question) => question.status === "pending"),
  ).toEqual([]);
  expect(state.sent[1].message.customType).toBe("question-dismissed");
});

test("questions restore a previously installed custom editor and its unfinished draft", () => {
  const state = fixture();
  const previous = (tui: any, theme: any) => new Editor(tui, theme);

  state.ctx.ui.setEditorComponent(previous);

  const [question] = state.client().ask([input]);

  expect(state.factory()).not.toBe(previous);
  state.client().withdraw([question.id]);
  expect(state.factory()).toBe(previous);
  expect(state.draft()).toBe("An unfinished prompt draft");
});

test("withdrawing another pending item cannot leave the choice cursor outside the menu", () => {
  const state = fixture();
  const [first, second] = state.client().ask([input, { ...input, question: "Other question?" }]);

  for (let index = 0; index < 4; index++) state.editor().handleInput("\x1b[B");

  state.client().withdraw([second.id]);
  state.editor().handleInput("\r");
  expect(
    state
      .client()
      .list()
      .find((question) => question.id === first.id)?.status,
  ).toBe("dismissed");
  expect(state.factory()).toBeUndefined();
});

test("the full question log remains expandable without submitting the saved prompt", () => {
  const state = fixture();
  let expanded = 0;

  state.client().ask([input]);
  state.editor().actionHandlers.set("app.tools.expand", () => {
    expanded++;
  });
  state.editor().handleInput("\x0f");
  expect(expanded).toBe(1);
  expect(state.sent).toEqual([]);
  expect(state.factory()).toBeDefined();
});

test("peer question identity is bound by the session and cannot be forged or reused after a switch", async () => {
  const state = fixture();
  const child: any = { ...state.ctx, sessionManager: { getBranch: () => [] } };

  bindPeerQuestions(state.ctx, child, "maple");
  sessionServices(child).mailbox = { name: "forged-name", active: () => true, audit() {} };

  const tool = state.tools.get("ask_user");
  const result = await tool.execute("ask", { questions: [input] }, undefined, undefined, child);

  expect(result.details.questions[0].owner).toBe("maple");
  expect(Check(tool.parameters, { owner: "other", questions: [input] })).toBe(false);
  expect(
    Check(state.tools.get("user_questions").parameters, {
      operation: "answer",
      ids: [result.details.questions[0].id],
      answer: "forged",
    }),
  ).toBe(false);
  expect(() => state.client("brook").withdraw([result.details.questions[0].id])).toThrow(
    "Unknown question",
  );
  state.entries.splice(0);
  state.fire("session_tree");
  expect(() => sessionServices(child).questions!("forged-name").list()).toThrow("no longer active");
});

test("command answers preserve internal whitespace and duplicate asks return one question", async () => {
  const state = fixture("rpc");
  const questions = state.client().ask([input, input]);

  expect(questions).toHaveLength(1);
  await state.commands
    .get("questions")
    .handler(`answer ${questions[0].id} Keep x  = y\nand two lines`, state.ctx);
  expect(state.client().list()[0].answer).toBe("Keep x  = y\nand two lines");
});

test("questions separate prompt, choices and guidance and theme the active answer", async () => {
  const state = fixture();
  const result = await state.tools
    .get("ask_user")
    .execute("layout", { questions: [input] }, undefined, undefined, state.ctx);

  expect(result.content[0].text).toContain(`\n\n${input.question}\n\n- Web`);

  const rendered = state.editor().render(100);
  const plain = rendered.map((line) => stripTerminalSequences(line).trimEnd());
  const question = plain.indexOf(input.question);
  const choice = plain.findIndex((line) => line.includes("› Web"));
  const hint = plain.findIndex((line) => line.startsWith("Enter:"));

  expect(plain[question - 1]).toBe("");
  expect(plain[question + 1]).toBe("");
  expect(choice).toBeGreaterThan(question + 1);
  expect(plain[hint - 1]).toBe("");
  expect(plain[hint + 1]).toBe("");

  const colors = getEditorTheme().selectList;

  expect(rendered[choice]).toBe(colors.selectedPrefix("› ") + colors.selectedText("Web"));
  expect(rendered).toContain("    " + colors.description("Browser client"));
});

test("long option descriptions wrap with indentation and short terminals retain the selected detail", () => {
  const state = fixture();

  state.client().ask([
    {
      ...input,
      options: [
        {
          label: "First choice",
          description:
            "Keep the current sandbox restrictions and use the existing tools to finish the work.",
        },
        {
          label: "Second choice",
          description: "Change the scope after checking which guarantees are required by the task.",
        },
      ],
    },
  ]);

  const lines = state.editor().render(45).map(stripTerminalSequences);

  expect(lines.some((line) => line.startsWith("    Keep the current sandbox"))).toBe(true);
  expect(lines.some((line) => line.endsWith("…"))).toBe(true);
  expect(lines.every((line) => visibleWidth(line) <= 45)).toBe(true);
  state.tui.terminal.rows = 20;

  const compact = state.editor().render(45).map(stripTerminalSequences);

  expect(compact.join("\n")).toContain("Second choice");
  expect(compact.join("\n")).not.toContain("Change the scope");
  expect(compact.length).toBeLessThan(20);
});

test("question panels suspend Tab queuing and restore the normal queue composer and original draft", () => {
  const state = fixture("tui", true);
  let queued = 0;
  const normal = state.factory();

  state.editor().addToHistory("Previous submitted prompt");

  state.editor().onAction("app.message.followUp", () => {
    queued++;
  });
  state.editor().handleInput("\t");
  expect(queued).toBe(1);

  const [question] = state.client().ask([input]);

  state.editor().onAction("app.message.followUp", () => {
    queued++;
  });
  state.editor().handleInput("\t");
  expect(queued).toBe(1);
  state.client().withdraw([question.id]);
  expect(state.factory()).toBe(normal);
  expect(state.editor().getText()).toBe("An unfinished prompt draft");
  state.editor().setText("");
  state.editor().handleInput("\x1b[A");
  expect(state.editor().getText()).toBe("Previous submitted prompt");
  state.editor().onAction("app.message.followUp", () => {
    queued++;
  });
  state.editor().handleInput("\t");
  expect(queued).toBe(2);
  state.fire("session_shutdown");
  expect(state.factory()).toBeUndefined();
});
