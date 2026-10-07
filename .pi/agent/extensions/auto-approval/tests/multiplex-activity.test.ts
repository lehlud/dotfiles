import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { foregroundAnsi, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TeamActivity, ACTIVITY_ENTRY, ACTIVITY_WIDGET, FEED_ENTRY, registerActivityRenderer } from "../../multiplex/activity.ts";
import { AGENT_COLORS, FeedView, mailboxRenderers, suppressNativeFeed } from "../../multiplex/presentation.ts";
import { Mailboxes } from "../../multiplex/mailboxes.ts";
import { Peer } from "../../multiplex/peer.ts";

const theme: any = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
function fixture() {
  const records: any[] = [], frames: string[][] = [];
  let removed = false;
  const pi = { appendEntry: (type: string, data: any) => records.push({ type, data }) } as any;
  const ctx = { ui: { setWidget(key: string, content: any) {
    expect(key).toBe(ACTIVITY_WIDGET);
    if (!content) removed = true;
    else frames.push(content({}, theme).render(1000));
  } } } as any;
  const activity = new TeamActivity(pi, ctx, "team", "otter", ["otter", "maple", "hare"]);
  return { activity, records, frames, removed: () => removed };
}

test("the overview follows every member, parallel tools, streamed output and teardown without model messages", async () => {
  const { activity, records, frames, removed } = fixture();
  for (const name of ["otter", "maple", "hare"]) activity.observe(name, { type: "agent_start" });
  activity.observe("maple", { type: "tool_execution_start", toolCallId: "one", toolName: "approved_action", args: { tool: "bash", arguments: { command: "npm run build" }, sandbox: { environment: { PRIVATE: "NEVER-COPY" } } } });
  activity.observe("maple", { type: "tool_execution_start", toolCallId: "two", toolName: "mailbox", args: { operation: "peers" } });
  activity.observe("maple", { type: "tool_execution_update", toolCallId: "one", toolName: "approved_action", args: {}, partialResult: { content: [{ type: "text", text: "building..." }] } });
  expect(records.find((entry) => entry.data.kind === "tool-output")?.data.body).toBe("building...");
  expect(frames.at(-1)?.join("\n")).toContain("maple  Running         bash, mailbox");
  activity.observe("maple", { type: "tool_execution_end", toolCallId: "two", toolName: "mailbox", result: {}, isError: false });
  expect(frames.at(-1)?.join("\n")).toContain("maple  Running         bash");
  activity.observe("maple", { type: "tool_execution_end", toolCallId: "one", toolName: "approved_action", result: { content: [{ type: "text", text: "failed build" }] }, isError: true });
  activity.observe("hare", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "LIVE-PREVIEW" }] }, assistantMessageEvent: { type: "text_delta" } } as any);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(frames.at(-1)?.join("\n")).toContain("hare   Writing         LIVE-PREVIEW");
  expect(records.every((entry) => entry.type === ACTIVITY_ENTRY && entry.data.teamId === "team")).toBe(true);
  expect(JSON.stringify(records)).not.toContain("NEVER-COPY");
  expect(records.some((entry) => entry.data.text === "bash · Failed")).toBe(true);
  activity.observe("operator", { type: "agent_start" });
  expect(records.some((entry) => entry.data.from === "operator")).toBe(false);
  activity.observe("hare", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "late" }] }, assistantMessageEvent: { type: "text_delta" } } as any);
  activity.close(); const before = records.length, frameCount = frames.length;
  activity.observe("maple", { type: "agent_start" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(removed()).toBe(true); expect(records).toHaveLength(before); expect(frames).toHaveLength(frameCount);
});

test("saved activity renders with runtime attribution, terminal sanitization and collapsed long bodies", () => {
  let render: any;
  registerActivityRenderer({ registerEntryRenderer(type: string, value: any) { if (type === ACTIVITY_ENTRY) render = value; } } as any);
  const data = { teamId: "team", from: "maple", kind: "tool-end", text: "bash · Finished", body: `\x1b[2J${Array.from({ length: 8 }, (_, i) => `line-${i}`).join("\n")}` };
  const compact = render({ data }, { expanded: false }, theme).render(1000).join("\n");
  expect(compact).toContain("Agent · maple · bash · Finished");
  expect(compact).not.toContain("\x1b[2J"); expect(compact).not.toContain("line-7"); expect(compact).toContain("ctrl+o to expand");
  expect(render({ data }, { expanded: true }, theme).render(1000).join("\n")).toContain("line-7");
});


const coloredTheme: any = { ...theme, style: (text: string, options: any) => foregroundAnsi(options.fg, "truecolor") + text + "\x1b[39m" };

test("a broadcast produces one readable feed entry; recipient events and transport JSON stay invisible", () => {
  const records: any[] = [], view = new FeedView(), renderers = new Map<string, any>();
  const pi = { appendEntry: (type: string, data: any) => records.push({ type, data }), registerEntryRenderer: (type: string, render: any) => renderers.set(type, render) } as any;
  const activity = new TeamActivity(pi, { ui: { setWidget() {} } } as any, "team", "otter", ["otter", "maple", "hare"], view);
  const boxes = new Mailboxes(["otter", "maple", "hare"], (from, to, text) => activity.sent(from, to, text));
  for (const name of boxes.names) boxes.bind(name, { deliver: (letter) => activity.observe(name, { type: "message_end", message: { role: "custom", customType: "multiplex-letter", content: JSON.stringify(letter), details: letter } } as any), audit() {}, result() {} });
  activity.observe("otter", { type: "message_end", message: { role: "user", content: "Start" } } as any);
  const receipt = boxes.send("maple", "*", "I will review parser.ts.");
  expect(receipt).toHaveLength(2);
  const sends = records.filter((entry) => entry.data.kind === "send");
  expect(sends).toHaveLength(1); expect(sends[0].data.from).toBe("maple");
  expect(records.some((entry) => entry.data.kind === "mailbox")).toBe(false);
  expect(() => boxes.send("otter", "unknown", "Never delivered")).toThrow();
  expect(records.filter((entry) => entry.data.kind === "send")).toHaveLength(1);
  registerActivityRenderer(pi, view);
  const anchor = records.find((entry) => entry.type === FEED_ENTRY);
  const feed = renderers.get(FEED_ENTRY)({ data: anchor.data }, { expanded: false }, coloredTheme);
  const output = stripTerminalSequences(feed.render(100).join("\n"));
  expect(output).toContain("Agent · maple · Message → otter, hare");
  expect(output.match(/I will review parser.ts./g)).toHaveLength(1);
  expect(output).not.toContain("teamId"); expect(output).not.toContain(receipt[0].id); expect(output).not.toContain("Received");
  view.select("hare"); expect(feed.render(100)).toEqual([]);
  view.select(); expect(stripTerminalSequences(feed.render(100).join("\n"))).toBe(output);
  activity.close(); boxes.close();
});

test("every actor uses a distinct stable color and the compact table aligns without extra rows", () => {
  expect(new Set(AGENT_COLORS).size).toBe(16);
  for (const mode of ["truecolor", "256color"] as const) expect(new Set(AGENT_COLORS.map((color) => foregroundAnsi(parseColor(color), mode))).size).toBe(16);
  let component: any;
  const activity = new TeamActivity({ appendEntry() {} } as any, { ui: { setWidget(_key: string, build: any) { if (build) component = build({}, coloredTheme); } } } as any, "team", "otter", ["otter", "maple", "hare"]);
  for (const [name, index] of [["otter", 0], ["maple", 1], ["hare", 2]] as const) activity.observe(name, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `preview-${index}` }] }, assistantMessageEvent: { type: "text_delta" } } as any);
  const rows = component.render(80), plainRows = rows.map(stripTerminalSequences);
  expect(rows).toHaveLength(4);
  expect(new Set(rows.slice(1).map((row: string) => row.match(/^\x1b\[[^m]*m/)?.[0])).size).toBe(3);
  expect(new Set(plainRows.slice(1).map((row: string) => row.indexOf("Writing"))).size).toBe(1);
  expect(new Set(plainRows.slice(1).map((row: string) => row.indexOf("preview-"))).size).toBe(1);
  expect(component.render(24).every((row: string) => visibleWidth(row) <= 24)).toBe(true);
  expect(plainRows.join("\n")).not.toContain("main");
  activity.close();
});

test("confirmed edits from every actor render real line-numbered diffs; rejected edits never do", () => {
  initTheme("dark", false);
  const records: any[] = [], view = new FeedView(), renderers = new Map<string, any>();
  const pi = { appendEntry: (type: string, data: any) => records.push({ type, data }), registerEntryRenderer: (type: string, render: any) => renderers.set(type, render) } as any;
  const activity = new TeamActivity(pi, { ui: { setWidget() {} } } as any, "team", "otter", ["otter", "maple"], view);
  activity.observe("otter", { type: "message_end", message: { role: "user", content: "Edit" } } as any);
  for (const from of ["otter", "maple"]) {
    activity.observe(from, { type: "tool_execution_start", toolCallId: from, toolName: "approved_action", args: { tool: "edit", arguments: { path: `${from}.ts` } } });
    activity.observe(from, { type: "tool_execution_end", toolCallId: from, toolName: "approved_action", isError: false, result: { content: [{ type: "text", text: "Approved edit" }], details: { approval: { decision: "approve", action: { tool: "edit" } }, result: { diff: "-1 const old = 1;\n+1 const next = 2;" } } } });
  }
  activity.observe("maple", { type: "tool_execution_start", toolCallId: "denied", toolName: "approved_action", args: { tool: "edit", arguments: { path: "denied.ts" } } });
  activity.observe("maple", { type: "tool_execution_end", toolCallId: "denied", toolName: "approved_action", isError: true, result: { content: [{ type: "text", text: "Denied" }], details: { approval: { decision: "deny", action: { tool: "edit" } }, result: { diff: "UNEXECUTED" } } } });
  registerActivityRenderer(pi, view);
  const anchor = records.find((entry) => entry.type === FEED_ENTRY);
  const feed = renderers.get(FEED_ENTRY)({ data: anchor.data }, { expanded: false }, coloredTheme);
  const output = stripTerminalSequences(feed.render(120).join("\n"));
  expect(output).toContain("Agent · otter · edit otter.ts"); expect(output).toContain("Agent · maple · edit maple.ts");
  expect(output.match(/-1 const old = 1;/g)).toHaveLength(2); expect(output.match(/\+1 const next = 2;/g)).toHaveLength(2);
  expect(output).not.toContain("UNEXECUTED");
  view.select("maple"); expect(stripTerminalSequences(feed.render(120).join("\n"))).not.toContain("Agent · otter");
  const replay = new FeedView(); replay.restore(records.filter((entry) => entry.type === ACTIVITY_ENTRY).map((entry) => entry.data));
  expect(replay.hidesTool("otter")).toBe(true); expect(replay.hidesTool("maple")).toBe(false);
  activity.close();
});

test("ordinary mailbox rendering never displays raw envelope data or repeats sent text", () => {
  initTheme("dark", false);
  const row = new ToolExecutionComponent("mailbox", "send", { operation: "send", to: "hare", text: "One message" }, undefined, mailboxRenderers(), { requestRender() {} } as any, "/tmp");
  row.setArgsComplete(); row.markExecutionStarted(); row.updateResult({ content: [{ type: "text", text: '[{"id":"private-id"}]' }], details: [{ id: "private-id", from: "otter", to: "hare" }], isError: false });
  expect(row.render(80)).toEqual([]);
});

function compactingPeer() {
  const listeners = new Set<(event: any) => void>(), prompts: string[] = [], errors: string[] = [];
  const session: any = { isCompacting: true, isStreaming: false, subscribe: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); }, prompt: async (text: string) => {
    if (session.isCompacting) throw new Error("Compaction rejects input");
    prompts.push(text);
  }, clearQueue() {}, abort: async () => {}, dispose() {}, sessionManager: {} };
  return { peer: new Peer(session, (error) => errors.push(error), () => {}), session, prompts, errors, finish: () => { session.isCompacting = false; for (const listener of [...listeners]) listener({ type: "compaction_end" }); }, listenerCount: () => listeners.size };
}

test("steering survives peer compaction and a full mailbox queue without replaying accepted prompts", async () => {
  const state = compactingPeer();
  try {
    for (let i = 0; i < 256; i++) state.peer.prompt({ text: `operator-${i}` });
    expect(state.peer.canDeliver()).toBe(false);
    state.peer.prompt({ text: "important-steering", streamingBehavior: "steer" });
    await Bun.sleep(1); expect(state.prompts).toEqual([]); expect(state.errors).toEqual([]);
    state.finish();
    for (let i = 0; i < 1000 && state.peer.busy; i++) await Bun.sleep(1);
    expect(state.prompts).toHaveLength(257); expect(state.prompts.at(-1)).toBe("important-steering");
    expect(new Set(state.prompts).size).toBe(257); expect(state.errors).toEqual([]);
  } finally { await state.peer.close(); }
  expect(state.listenerCount()).toBe(0);
});

test("closing a peer cancels retained compaction inputs without a late model request", async () => {
  const state = compactingPeer();
  state.peer.prompt({ text: "Never start after shutdown" });
  await Bun.sleep(1); await state.peer.close(); state.finish();
  expect(state.prompts).toEqual([]); expect(state.errors).toEqual([]); expect(state.listenerCount()).toBe(0);
});


test("a real Pi SDK peer retains steering across manual compaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-peer-compaction-"));
  let peer: Peer | undefined, compact: Promise<unknown> | undefined, release!: () => void;
  const contexts: any[] = [], errors: string[] = [];
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  try {
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false });
    runtime.registerProvider("compaction-fixture", { api: "compaction-fixture", apiKey: "synthetic", baseUrl: "https://example.invalid", models: [{ id: "working", name: "working", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple(model, context) {
      contexts.push(structuredClone(context.messages));
      const stream = createAssistantMessageEventStream();
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage, stopReason: "stop", content: [{ type: "text", text: "Steering applied; task continued." }] };
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    } });
    const manager = SessionManager.inMemory(directory), settings = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1, reserveTokens: 1024 } });
    for (let i = 0; i < 3; i++) {
      manager.appendMessage({ role: "user", content: "Original task: validate the complete implementation. " + "context ".repeat(100), timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", api: "compaction-fixture", provider: "compaction-fixture", model: "working", content: [{ type: "text", text: "Intermediate progress. " + "context ".repeat(100) }], stopReason: "stop", timestamp: Date.now(), usage });
    }
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: [(pi) => { pi.on("session_before_compact", async (event) => {
      await new Promise<void>((done) => { release = done; });
      return { compaction: { summary: "Original task: validate the complete implementation; work remains.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    }); }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model: new ModelRegistry(runtime).find("compaction-fixture", "working")!, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "builtin" });
    await session.bindExtensions({ mode: "json" });
    peer = new Peer(session, (error) => errors.push(error), () => {});
    compact = session.compact();
    for (let i = 0; i < 1000 && !release; i++) await Bun.sleep(1);
    expect(session.isCompacting).toBe(true);
    peer.prompt({ text: "STEERING-DURING-COMPACTION: Keep the original task and correct the comments.", streamingBehavior: "steer" });
    await Bun.sleep(1); expect(contexts).toEqual([]); expect(errors).toEqual([]);
    release(); await compact;
    for (let i = 0; i < 1000 && peer.busy; i++) await Bun.sleep(1);
    expect(errors).toEqual([]); expect(contexts).toHaveLength(1);
    expect(JSON.stringify(contexts[0])).toContain("STEERING-DURING-COMPACTION");
    expect(JSON.stringify(contexts[0])).toContain("Original task: validate");
  } finally { release?.(); await compact?.catch(() => {}); await peer?.close(); await rm(directory, { recursive: true, force: true }); }
}, 10000);


test("the backend session has no duplicate native rows, including after stopping and restoring the feed", () => {
  const view = new FeedView(), callbacks: any = {};
  let active = true, previewReads = 0;
  suppressNativeFeed({ registerToolRenderer: (callback: any) => { callbacks.tool = callback; }, registerMarkdownTransformer: (callback: any) => { callbacks.markdown = callback; }, registerMessageRenderer: (_type: string, callback: any) => { callbacks.received = callback; } } as any, view, () => active);
  const source = [{ type: "text", text: "Backend member reply." }];
  const hashes = view.rootText(source, true); view.rootTool("edit-one");
  const renderers = callbacks.tool("approved_action", () => ({ renderCall() { previewReads++; throw new Error("Unreviewed renderer access"); }, renderResult() { throw new Error("Duplicated result"); } }));
  const context = { toolCallId: "edit-one", state: {}, args: { tool: "edit", arguments: { path: "unread.ts" } } };
  expect(renderers.renderCall(context.args, theme, context).render(80)).toEqual([]);
  expect(renderers.renderResult({ content: [] }, { expanded: true }, theme, context).render(80)).toEqual([]);
  expect(previewReads).toBe(0);
  expect(callbacks.markdown(source[0].text, { messageType: "assistant" })).toBe("");
  expect(callbacks.markdown("Older unrelated message", { messageType: "assistant" })).toBe("Older unrelated message");
  expect(callbacks.markdown(source[0].text, { messageType: "user" })).toBe(source[0].text);
  expect(callbacks.received({ details: { text: "Don't repeat" } }).render(80)).toEqual([]);
  active = false;
  expect(renderers.renderCall(context.args, theme, context).render(80)).toEqual([]);
  view.restore([{ teamId: "team", from: "otter", kind: "message", text: "Reply", body: source[0].text, backend: true, nativeTexts: hashes, toolCallId: "edit-one" }]);
  expect(view.hidesTool("edit-one")).toBe(true); expect(view.hidesText(source[0].text)).toBe(true);
  expect(source[0].text).toBe("Backend member reply.");
});
