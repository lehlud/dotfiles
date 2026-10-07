import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext, type InputEvent,
} from "@earendil-works/pi-coding-agent";
import autoApproval from "../auto-approval/index.ts";
import publicWriting from "../public-writing/index.ts";
import { registerSteering } from "../conversations/steering.ts";
import { installProviderStreams } from "../auto-approval/provider-stream.ts";
import { sessionServices } from "../auto-approval/session-services.ts";
import { registerEndpoint, type Endpoint } from "./endpoint.ts";
import { letterMessage, PEER_RESULT, type Letter } from "./mailboxes.ts";

/** Alle Peers benutzen dieselben vertrauenswürdigen Provider, keine Auth-Kopie im Modell. */
export async function peerRuntime(ctx: ExtensionContext) {
  installProviderStreams(ctx.modelRegistry);
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  for (const id of new Set(ctx.modelRegistry.getAll().map((model) => model.provider))) {
    const provider = ctx.modelRegistry.getProvider(id);
    if (provider) runtime.registerNativeProvider(provider);
  }
  return runtime;
}

export class Peer {
  private admission: Promise<void> = Promise.resolve();
  private runs = new Set<Promise<void>>();
  private stopped = false;
  private pending = 0;
  constructor(readonly session: AgentSession, private report: (error: string) => void, private settled: () => void) {}
  get busy() { return this.pending > 0 || this.runs.size > 0 || this.session.isStreaming; }
  canDeliver() { return !this.stopped && this.pending < 256; }
  private enqueue(start: () => Promise<void>) {
    if (this.stopped) return;
    if (this.pending >= 256) throw new Error("Peer input queue is full");
    this.pending++;
    this.admission = this.admission.then(async () => {
      if (this.stopped) return;
      let ready!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      const unsubscribe = this.session.subscribe((event) => { if (event.type === "agent_start") ready(); });
      const run = start().catch(() => { if (!this.stopped) this.report("Peer-Anfrage fehlgeschlagen; keine automatische Wiederholung des Auftrags."); });
      this.runs.add(run);
      void run.finally(() => { this.runs.delete(run); if (!this.stopped && !this.busy) this.settled(); });
      try { await Promise.race([started, run]); }
      finally { unsubscribe(); }
    }).catch(() => this.report("Peer-Zustellung fehlgeschlagen.")).finally(() => { this.pending--; if (!this.stopped && !this.busy) this.settled(); });
  }
  prompt(event: Pick<InputEvent, "text" | "images" | "streamingBehavior">) {
    const copy = structuredClone(event);
    this.enqueue(() => this.session.prompt(copy.text, { images: copy.images, expandPromptTemplates: false, source: "interactive", streamingBehavior: copy.streamingBehavior ?? "steer" }));
  }
  message(message: Parameters<AgentSession["sendCustomMessage"]>[0]) {
    const copy = structuredClone(message);
    this.enqueue(() => this.session.sendCustomMessage(copy, { triggerTurn: true, deliverAs: "steer" }));
  }
  deliver(letter: Letter) { this.message(letterMessage(letter)); }
  audit(data: Record<string, unknown>) { if (!this.stopped) this.session.sessionManager.appendCustomEntry("auto-approval-review", data); }
  result(data: Record<string, unknown>) { if (!this.stopped) this.session.sessionManager.appendCustomEntry(PEER_RESULT, data); }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.session.clearQueue();
    await this.session.abort();
    await this.admission;
    this.session.clearQueue();
    // Ein noch laufender Auth-/Start-Hook kann erst nach dem ersten Abbruch
    // in die SDK-Schleife eintreten. Auch diesen späteren Start abbrechen.
    await this.session.abort();
    await Promise.allSettled([...this.runs]);
    try { await sessionServices({ sessionManager: this.session.sessionManager }).cleanup?.(); }
    finally { this.session.dispose(); }
  }
}

export async function createPeer(ctx: ExtensionContext, endpoint: Endpoint, runtime: ModelRuntime, report: (error: string) => void, answer: (text: string) => void, settled: () => void, branch = ctx.sessionManager.getBranch()) {
  const entries = structuredClone(branch);
  const manager = SessionManager.inMemory(ctx.cwd, undefined, [{ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: ctx.cwd }, ...entries]);
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    systemPrompt: ctx.getSystemPrompt(), extensionFactories: [autoApproval, publicWriting, (pi) => {
      pi.on("session_start", (_event, child) => { sessionServices(child).operatorGoal = endpoint.operatorGoal; });
      registerSteering(pi, endpoint.operatorGoal);
      registerEndpoint(pi, () => endpoint);
      pi.on("turn_end", (event) => {
        if (event.outcome === "error") report("Peer-Modelllauf fehlgeschlagen; Ergebnis nicht vollständig.");
      });
      pi.on("agent_settled", (_event, child) => {
        const last = child.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
        if (last?.type === "message" && last.message.role === "assistant") {
          const text = Array.isArray(last.message.content) ? last.message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n") : "";
          if (text) answer(text);
        }
      });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: ctx.cwd, agentDir: getAgentDir(), modelRuntime: runtime, model: ctx.model, thinkingLevel: ctx.thinkingLevel ?? "medium", sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: ["approved_action", "mailbox"] });
  try {
    await session.bindExtensions({ mode: "json", onError: () => report("Peer-Extension meldet einen Fehler."), uiContext: { setStatus() {}, setWidget() {}, notify: (_text: string, kind?: string) => { if (kind === "error") report("Peer-Sandbox oder Konfiguration ist nicht verfügbar."); } } as any });
    return new Peer(session, report, settled);
  } catch (error) {
    await sessionServices({ sessionManager: manager }).cleanup?.(); session.dispose(); throw error;
  }
}
