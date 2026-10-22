import { afterEach, beforeEach, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  setKeybindings,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { SearchPicker } from "../../model-selection/picker.ts";
import { chooseReviewer } from "../../model-selection/interactive.ts";
import { reviewerThinkingLevels } from "../../model-selection/capabilities.ts";
import { registerReviewerCommand } from "../../model-selection/command.ts";
import { sessionServices } from "../../shared/session/services.ts";

let previousKeys = getKeybindings();

beforeEach(() => {
  initTheme("dark", false);
  previousKeys = getKeybindings();
  setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

const primary = { provider: "fixture", model: "working", thinking: "low" } as const;
const replacement = { provider: "openrouter", model: "vendor/review", thinking: "high" } as const;

function fixture(answers: (string | undefined)[] = []) {
  const models: any[] = [
    { provider: "fixture", id: "working", name: "Working model", reasoning: true },
    { provider: "fixture", id: "fallback", name: "Fallback model", reasoning: true },
    {
      provider: "openrouter",
      id: "vendor/review",
      name: "Review model",
      reasoning: true,
      thinkingLevelMap: { off: null, low: "low", high: "high", xhigh: null },
    },
    { provider: "fixture", id: "plain", name: "Plain model", reasoning: false },
  ];
  const dialogs: { title: string; options: string[] }[] = [];
  const notices: string[] = [];
  const ctx: any = {
    hasUI: true,
    mode: "rpc",
    sessionManager: {},
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: () => true,
    },
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (title: string, options: string[]) => {
        dialogs.push({ title, options });

        const answer = answers.shift();

        return answer ? options.find((item) => item.replace(/^✓ /, "") === answer) : undefined;
      },
    },
  };

  return { ctx, dialogs, notices, models };
}

test("the native-input picker searches provider, ID and name, preselects and handles Escape", () => {
  const items = [
    { value: "openai/first", label: "openai/first", description: "Quick responses" },
    {
      value: "openrouter/vendor/second",
      label: "openrouter/vendor/second",
      description: "Careful reasoning",
    },
  ];
  const selected: (string | undefined)[] = [];
  const picker = new SearchPicker(
    "Approval model",
    items,
    (value) => selected.push(value),
    theme,
    5,
    items[1].value,
  );

  picker.focused = true;
  expect(picker.input.focused).toBe(true);
  picker.handleInput("\r");
  expect(selected).toEqual([items[1].value]);
  picker.handleInput("quick");
  picker.handleInput("\r");
  expect(selected.at(-1)).toBe(items[0].value);
  picker.handleInput("\x15");
  picker.handleInput("vendor");
  picker.handleInput("\r");
  expect(selected.at(-1)).toBe(items[1].value);
  picker.handleInput("\x1b");
  expect(selected.at(-1)).toBeUndefined();
  picker.dispose();
});

test("large catalog lists stay bounded, searchable and within terminal width", () => {
  const items = Array.from({ length: 2000 }, (_, index) => ({
    value: `provider/model-${index}`,
    label: `provider/model-${index}`,
  }));
  const picker = new SearchPicker("Approval model", items, () => {}, theme, 5);
  const rows = picker.render(50);

  expect(rows.length).toBeLessThan(20);
  expect(rows.every((row) => visibleWidth(row) <= 50)).toBe(true);
  picker.handleInput("missing-model");
  expect(stripTerminalSequences(picker.render(50).join("\n"))).toContain("No matching");
  picker.dispose();
});

test("closing a picker detaches its cancellation listener", () => {
  const controller = new AbortController();
  const selected: (string | undefined)[] = [];
  const picker = new SearchPicker(
    "Model",
    [],
    (value) => selected.push(value),
    theme,
    5,
    undefined,
    controller.signal,
  );

  controller.abort();
  expect(selected).toEqual([undefined]);
  picker.dispose();

  const other = new AbortController();
  const disposed = new SearchPicker(
    "Model",
    [],
    (value) => selected.push(value),
    theme,
    5,
    undefined,
    other.signal,
  );

  disposed.dispose();
  other.abort();
  expect(selected).toEqual([undefined]);
});

test("selection replaces the reviewer using known models and supported thinking levels", async () => {
  const app = fixture(["openrouter/vendor/review", "high"]);
  const next = await chooseReviewer(primary, app.ctx, new AbortController().signal);

  expect(app.dialogs[1].options).toEqual(["✓ low", "high"]);
  expect(next).toEqual(replacement);
  expect(primary.thinking).toBe("low");
});

test("the complete terminal flow uses searchable native components for both choices", async () => {
  const app = fixture();
  const screens: string[] = [];

  app.ctx.mode = "tui";
  app.ctx.ui.custom = (factory: Function) =>
    new Promise((resolve) => {
      const picker = factory({ terminal: { rows: 24 } }, theme, getKeybindings(), resolve);

      screens.push(stripTerminalSequences(picker.render(80).join("\n")));
      picker.handleInput(screens.length === 1 ? "vendor/review" : "high");
      picker.handleInput("\r");
      picker.dispose();
    });

  expect(await chooseReviewer(primary, app.ctx, new AbortController().signal)).toEqual(replacement);
  expect(screens[0]).toContain("Approval model");
  expect(screens[1]).toContain("Approval thinking");
});

test("cancel at either stage, unavailable models and headless invocation leave preferences alone", async () => {
  for (const answers of [[undefined], ["openrouter/vendor/review", undefined]]) {
    const stages = answers.length;
    const app = fixture([...answers]);

    expect(await chooseReviewer(primary, app.ctx, new AbortController().signal)).toBeUndefined();
    expect(app.dialogs.length).toBe(stages);
  }

  const app = fixture();

  app.models.length = 0;
  expect(await chooseReviewer(primary, app.ctx, new AbortController().signal)).toBeUndefined();
  expect(app.notices.at(-1)).toContain("/login");
  app.ctx.hasUI = false;
  expect(await chooseReviewer(primary, app.ctx, new AbortController().signal)).toBeUndefined();
  expect(app.notices.at(-1)).toContain("/reviewer set");
});

test("model capabilities exclude disabled and unsupported levels and plain models offer off", () => {
  const app = fixture();

  expect(reviewerThinkingLevels(app.models[2])).toEqual(["low", "high"]);
  expect(reviewerThinkingLevels(app.models[3])).toEqual(["off"]);
  expect(reviewerThinkingLevels(app.models[0])).toEqual([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

test("a replaced command or session shutdown cancels an open picker without a stale save", async () => {
  const app = fixture();
  const hooks: Record<string, Function[]> = {};
  let command: any;
  let current: typeof primary | typeof replacement = primary;
  const saved: unknown[] = [];
  const opened = Promise.withResolvers<void>();

  app.ctx.ui.select = async (
    _title: string,
    _options: string[],
    { signal }: { signal: AbortSignal },
  ) => {
    opened.resolve();

    return new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve(undefined), { once: true }),
    );
  };
  sessionServices(app.ctx).activeReviewer = () => current;
  registerReviewerCommand(
    {
      on: (name: string, handler: Function) => {
        hooks[name] = [...(hooks[name] ?? []), handler];
      },
      registerCommand: (_name: string, definition: unknown) => {
        command = definition;
      },
    } as any,
    () => current,
    (next) => {
      current = next as typeof current;
      saved.push(next);
    },
  );

  const pending = command.handler("", app.ctx);

  await opened.promise;
  await command.handler("", app.ctx);
  expect(app.notices.at(-1)).toContain("already open");
  await command.handler("set openrouter/vendor/review high", app.ctx);
  await pending;
  expect(saved).toEqual([replacement]);

  const shutdown = command.handler("", app.ctx);

  await Promise.resolve();

  for (const handler of hooks.session_shutdown) handler({}, app.ctx);

  await shutdown;
  expect(saved).toEqual([replacement]);
});
