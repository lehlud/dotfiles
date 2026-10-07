import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { registerSide } from "../../conversations/side.ts";

const tick = () => new Promise<void>((done) => setTimeout(done, 1));
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await tick();
  if (!check()) throw new Error("SDK fixture did not reach its expected state");
}

async function fixture(directory: string) {
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false });
  let releaseMain: (() => void) | undefined, mainStarted = false;
  const sideContexts: any[] = [];
  runtime.registerProvider("side-sdk-fixture", {
    api: "side-sdk-fixture", apiKey: "test-fixture", baseUrl: "https://example.invalid",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const side = getCurrentSystemPrompt(context.messages).includes("temporary side conversation");
        const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "" }], timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        if (side) sideContexts.push(structuredClone(context));
        else { mainStarted = true; await new Promise<void>((done) => { releaseMain = done; }); }
        message.content[0].text = side ? "Side answer based on the parent context." : "MAIN-FINISHED parser checks passed.";
        stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
        if (options?.signal?.aborted) { message.stopReason = "aborted"; stream.push({ type: "error", reason: "aborted", error: message }); }
        else stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  });
  const model = new ModelRegistry(runtime).find("side-sdk-fixture", "fixture")!;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: [(pi) => registerSide(pi)] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager: SessionManager.inMemory(directory), settingsManager, resourceLoader, noTools: "all" });
  return { session, sideContexts, mainStarted: () => mainStarted, releaseMain: () => releaseMain?.() };
}

test("real Pi SDK runs /side immediately during a parent turn without changing its transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-side-sdk-"));
  const state = await fixture(directory);
  let view: any, main: Promise<void> | undefined, side: Promise<void> | undefined;
  const statuses = new Map<string, string>([["00-goal", "goal: parser"]]);
  try {
    initTheme("dark", false);
    await state.session.bindExtensions({ mode: "tui", uiContext: {
      setStatus: (key: string, value?: string) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      notify: (text: string) => { throw new Error(text); },
      custom: (factory: Function) => new Promise<void>((done) => { view = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, {}, done); }),
    } as any });
    main = state.session.prompt("MAIN-INTENT repair the parser and verify it.");
    await until(state.mainStarted); expect(state.session.isStreaming).toBe(true);
    side = state.session.prompt("/side SIDE-QUESTION what is the main task?");
    await until(() => view?.conversation.history.length === 2);
    expect(state.session.isStreaming).toBe(true);
    expect(JSON.stringify(state.sideContexts[0])).toContain("MAIN-INTENT");
    expect(JSON.stringify(state.session.sessionManager.getBranch())).not.toContain("SIDE-QUESTION");
    state.releaseMain(); await main;
    expect(state.session.isStreaming).toBe(false);
    view.editor.onSubmit("SIDE-FOLLOWUP what finished since I opened this chat?");
    await until(() => view.conversation.history.length === 4);
    expect(JSON.stringify(state.sideContexts[1])).toContain("MAIN-FINISHED");
    expect(JSON.stringify(state.session.sessionManager.getBranch())).not.toContain("SIDE-FOLLOWUP");
    view.handleInput("\x1b"); await side;
    expect(statuses.get("00-goal")).toBe("goal: parser"); expect(statuses.has("01-side")).toBe(false);
    expect(state.session.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant")).toBe(true);
  } finally {
    state.releaseMain(); view?.dispose(); view?.handleInput("\x03");
    await main?.catch(() => {}); await side?.catch(() => {});
    state.session.dispose(); await rm(directory, { recursive: true, force: true });
  }
}, 15000);
