import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerGoals } from "../goals.ts";
import { textContent } from "../policy.ts";

async function fixture(directory: string) {
  await writeFile(join(directory, "auto-approval.json"), JSON.stringify({ reviewers: [{ provider: "goal-sdk-fixture", model: "reviewer", thinking: "off" }], recentUserPrompts: 2, requestTimeoutMs: 1000, sandbox: { backend: "bwrap" } }));
  await writeFile(join(directory, "auto-approval.device.json"), JSON.stringify({ sandbox: { executable: process.execPath, runnerExecutable: process.execPath } }));
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false });
  const contexts: any[] = [];
  runtime.registerProvider("goal-sdk-fixture", {
    api: "goal-sdk-fixture", apiKey: "test-fixture", baseUrl: "https://example.invalid",
    models: ["working", "reviewer"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      contexts.push({ model: model.id, messages: structuredClone(context.messages) });
      const data = model.id === "reviewer" ? JSON.parse(textContent(context.messages.find((entry) => entry.role === "user")!.content)) : undefined;
      const text = data ? JSON.stringify({ requestId: data.requestId, decision: "approve", reason: "Das Ergebnis liegt vor." }) : "Das gespeicherte Ziel wurde fortgesetzt.";
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text }], timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); });
      return stream;
    },
  });
  const sessionManager = SessionManager.inMemory(directory);
  sessionManager.appendCustomEntry("auto-approval-operator-prompt", { goalId: "saved-goal", text: "Erkläre das gespeicherte Prüfergebnis." });
  sessionManager.appendCustomEntry("auto-approval-goal", { id: "saved-goal", text: "Erkläre das gespeicherte Prüfergebnis.", status: "paused", checks: 1, reason: "Interrupted by operator; use /goal resume" });
  sessionManager.appendCustomEntry("auto-approval-goal-review", { goalId: "saved-goal", verdict: { decision: "deny", reason: "Erkläre noch das Testergebnis." } });
  sessionManager.appendCustomMessageEntry("auto-approval-goal-instruction", "Operator goal: obsolete\nMissing work: use /goal resume", false);
  sessionManager.appendCustomMessageEntry("unrelated-fixture", "KEEP-UNRELATED-CONTEXT", false);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: [(pi) => { registerGoals(pi); }] });
  await resourceLoader.reload();
  const model = new ModelRegistry(runtime).find("goal-sdk-fixture", "working")!;
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager, settingsManager, resourceLoader, noTools: "all" });
  return { session, contexts };
}

test("real Pi SDK resumes a legacy goal with one task instruction and no raw command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const { session, contexts } = await fixture(directory);
  const notices: string[] = [];
  try {
    await session.bindExtensions({ mode: "tui", uiContext: { setStatus() {}, notify: (text: string) => notices.push(text) } as any });
    const original = structuredClone(session.sessionManager.getBranch());
    await session.prompt("/goal resume");
    for (let i = 0; i < 1000 && !notices.some((text) => text.startsWith("Goal confirmed:")); i++) await new Promise<void>((done) => setTimeout(done, 1));
    expect(notices.join("\n")).toContain("Goal resumed:"); expect(notices.join("\n")).toContain("Goal confirmed:");
    const working = contexts.filter((entry) => entry.model === "working");
    expect(working).toHaveLength(1);
    const input = JSON.stringify(working[0].messages);
    expect(input).toContain("Erkläre das gespeicherte Prüfergebnis."); expect(input).toContain("Erkläre noch das Testergebnis.");
    expect(input.match(/Operator goal:/g)).toHaveLength(1);
    expect(input).not.toContain("/goal resume"); expect(input).not.toContain("obsolete");
    expect(input).toContain("KEEP-UNRELATED-CONTEXT");
    expect(session.sessionManager.getBranch().slice(0, original.length)).toEqual(original);
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user")).toBe(false);
  } finally {
    session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
