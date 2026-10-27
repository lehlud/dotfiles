import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  initTheme,
  theme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { registerDialogues } from "../../conversations/side.ts";
import { watchInterrupt } from "../../shared/session/interrupt.ts";

const tick = () => new Promise<void>((done) => setTimeout(done, 1));

async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await tick();

  if (!check()) throw new Error("SDK fixture did not reach its expected state");
}

async function fixture(directory: string) {
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: false,
  });
  let releaseMain: (() => void) | undefined,
    mainStarted = false,
    parentInterrupts = 0;
  const sideContexts: any[] = [];

  runtime.registerProvider("side-sdk-fixture", {
    api: "side-sdk-fixture",
    apiKey: "test-fixture",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 65536,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();

      queueMicrotask(async () => {
        const system = getCurrentSystemPrompt(context.messages);
        const nietzsche = system.includes("You are the Nietzschian Debugger");
        const side = nietzsche || system.includes("temporary side conversation");
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "text", text: "" }],
          timestamp: Date.now(),
          stopReason: "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };

        stream.push({ type: "start", partial: message });

        if (side) sideContexts.push(structuredClone(context));
        else {
          mainStarted = true;
          await new Promise<void>((done) => {
            releaseMain = done;
          });
        }

        message.content[0].text = nietzsche
          ? "What evidence separates failing users from successful ones?"
          : side
            ? "Side answer based on the parent context."
            : "MAIN-FINISHED parser checks passed.";
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: message.content[0].text,
          partial: message,
        });

        if (options?.signal?.aborted) {
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else stream.push({ type: "done", reason: "stop", message });
      });

      return stream;
    },
  });

  const model = new ModelRegistry(runtime).find("side-sdk-fixture", "fixture")!;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => {
        registerDialogues(pi);

        let detach: (() => void) | undefined;

        pi.on("session_start", (_event, ctx) => {
          detach?.();
          detach = watchInterrupt(
            ctx,
            () => !ctx.isIdle(),
            async () => {
              parentInterrupts++;
              await ctx.abort();
            },
          );
        });
        pi.on("session_shutdown", () => detach?.());
      },
    ],
  });

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
    resourceLoader,
    noTools: "all",
  });

  return {
    session,
    sideContexts,
    mainStarted: () => mainStarted,
    parentInterrupts: () => parentInterrupts,
    releaseMain: () => releaseMain?.(),
  };
}

for (const command of ["side", "nietzsche"]) {
  test(`real Pi SDK runs /${command} during parent work without changing its transcript`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-side-sdk-"));
    const state = await fixture(directory);
    let view: any, main: Promise<void> | undefined, side: Promise<void> | undefined;
    const statuses = new Map<string, string>([["00-goal", "goal: parser"]]);
    let overlay: any;

    try {
      initTheme("dark", false);
      await state.session.bindExtensions({
        mode: "tui",
        uiContext: {
          setStatus: (key: string, value?: string) => {
            if (value === undefined) statuses.delete(key);
            else statuses.set(key, value);
          },

          notify: (text: string) => {
            throw new Error(text);
          },

          custom: (factory: Function, options: any) =>
            new Promise<void>((done) => {
              overlay = options;
              view = factory(
                { terminal: { rows: 24, columns: 80 }, requestRender() {} },
                theme,
                {},
                done,
              );
            }),
        } as any,
      });
      main = state.session.prompt("MAIN-INTENT repair the parser and verify it.");
      await until(state.mainStarted);
      expect(state.session.isStreaming).toBe(true);
      side = state.session.prompt(`/${command} SIDE-QUESTION some users receive 403`);
      await until(() => view?.conversation.history.length === 2);
      expect(state.session.isStreaming).toBe(true);
      expect(JSON.stringify(state.sideContexts[0])).toContain("MAIN-INTENT");
      expect(view.conversation.profile.id).toBe(command);
      expect(overlay.overlayOptions.maxHeight).toBe(command === "nietzsche" ? "100%" : "80%");

      if (command === "nietzsche") {
        expect(view.render(80)).toHaveLength(24);
        expect(view.render(80).map(stripTerminalSequences).join("\n")).not.toContain("You:");
      }

      expect(state.sideContexts[0].tools).toBeUndefined();

      if (command === "nietzsche") {
        expect(getCurrentSystemPrompt(state.sideContexts[0].messages)).toContain(
          "ONE focused question",
        );
        expect(view.conversation.turns[0].answer).toEndWith("?");
      }

      expect(JSON.stringify(state.session.sessionManager.getBranch())).not.toContain(
        "SIDE-QUESTION",
      );
      state.releaseMain();
      await main;
      expect(state.session.isStreaming).toBe(false);
      view.editor.onSubmit("SIDE-FOLLOWUP what finished since I opened this chat?");
      await until(() => view.conversation.history.length === 4);
      expect(JSON.stringify(state.sideContexts[1])).toContain("MAIN-FINISHED");
      expect(JSON.stringify(state.session.sessionManager.getBranch())).not.toContain(
        "SIDE-FOLLOWUP",
      );
      view.handleInput("\x1b");
      await side;
      expect(statuses.get("00-goal")).toBe("goal: parser");
      expect(statuses.has("01-side")).toBe(false);
      expect(
        state.session.sessionManager
          .getBranch()
          .some((entry) => entry.type === "message" && entry.message.role === "assistant"),
      ).toBe(true);
    } finally {
      state.releaseMain();
      view?.dispose();
      view?.handleInput("\x03");
      await main?.catch(() => {});

      await side?.catch(() => {});

      state.session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
}

test("real Pi SDK leaves parent work running when global listeners receive side return keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-side-interrupt-sdk-"));
  const state = await fixture(directory);
  let view: any, main: Promise<void> | undefined, side: Promise<void> | undefined;
  let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;

  try {
    initTheme("dark", false);
    await state.session.bindExtensions({
      mode: "tui",
      uiContext: {
        setStatus() {},
        notify() {},
        onTerminalInput: (handler: typeof listener) => {
          listener = handler;

          return () => {
            listener = undefined;
          };
        },
        custom: (factory: Function) =>
          new Promise<void>((done) => {
            view = factory(
              { terminal: { rows: 24, columns: 80 }, requestRender() {} },
              theme,
              {},
              done,
            );
            view.focused = true;
          }),
      } as any,
    });
    main = state.session.prompt("Repair the parser and verify it.");
    await until(state.mainStarted);

    for (const key of ["\x1b", "\x03"]) {
      view = undefined;
      side = state.session.prompt("/side What is happening?");
      await until(() => view?.conversation.history.length === 2);
      expect(listener).toBeDefined();

      if (!listener?.(key)?.consume) view.handleInput(key);

      await side;
      expect(state.parentInterrupts()).toBe(0);
      expect(state.session.isStreaming).toBe(true);
      expect(view.conversation.closed).toBe(true);
    }
  } finally {
    state.releaseMain();
    view?.handleInput("\x03");
    await side?.catch(() => {});
    await main?.catch(() => {});
    state.session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
