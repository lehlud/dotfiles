import { ActionFailures } from "../../multiplex/action-failures.ts";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, ToolExecutionComponent, AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Container, Spacer, Text, foregroundAnsi, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TeamActivity, ACTIVITY_ENTRY, ACTIVITY_WIDGET, FEED_ENTRY, registerActivityRenderer } from "../../multiplex/activity.ts";
import { AGENT_COLORS, FeedView, mailboxRenderers, suppressNativeFeed } from "../../multiplex/presentation.ts";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
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

test("state and thinking stay in the overview and legacy records never reappear in the feed", () => {
  const { activity, records, frames } = fixture();
  activity.observe("otter", { type: "agent_start" });
  activity.observe("otter", { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Working through evidence" }] }, assistantMessageEvent: { type: "thinking_delta" } } as any);
  activity.refresh(true); expect(frames.at(-1)?.join("\n")).toContain("Thinking");
  activity.observe("otter", { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Working through evidence" }] } } as any);
  activity.observe("otter", { type: "agent_settled" });
  expect(records.some((entry) => entry.data.kind === "state" || entry.data.kind === "thinking")).toBe(false);
  expect(frames.at(-1)?.join("\n")).toContain("Ready");
  const renderers = new Map<string, any>(), view = new FeedView();
  registerActivityRenderer({ registerEntryRenderer: (type: string, renderer: any) => renderers.set(type, renderer) } as any, view);
  for (const kind of ["state", "thinking", "native-hidden"]) {
    const record: any = { teamId: "old", from: "otter", kind, text: "Working", body: "Old status", segment: "old" };
    expect(renderers.get(ACTIVITY_ENTRY)({ data: { ...record, segment: undefined } }, { expanded: false }, theme)).toBeUndefined();
    view.append(record);
  }
  const feed = renderers.get(FEED_ENTRY)({ data: { segment: "old" } }, { expanded: false }, theme);
  expect(feed.render(100)).toEqual([]); activity.close();
});

test("hidden native assistant rows reserve no space after the shared feed", () => {
  initTheme("dark", false);
  const view = new FeedView(); let transformer: any;
  suppressNativeFeed({ registerToolRenderer() {}, registerMarkdownTransformer(fn: any) { transformer = fn; }, registerMessageRenderer() {} } as any, view, () => true);
  const document = new Container();
  document.addChild(new Text("SHARED-FEED-END", 0, 0));
  const messages = Array.from({ length: 16 }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `Already displayed reply ${i}` }], stopReason: "stop" } as any));
  for (const message of messages) {
    view.rootText(message.content, true);
    document.addChild(new AssistantMessageComponent(message, false, undefined, undefined, undefined, [transformer]));
  }
  const ui = { children: [document], invalidate() {}, requestRender() {} } as any;
  view.bind(ui);
  const frame = document.render(80).map((line) => stripTerminalSequences(line).trimEnd());
  expect(frame).toEqual(["SHARED-FEED-END"]);
  expect(messages[0].content[0].text).toBe("Already displayed reply 0");
});


test("transcript compaction preserves visible spacing and warnings while catching later native rows", () => {
  initTheme("dark", false);
  const view = new FeedView(); let transformer: any;
  suppressNativeFeed({ registerToolRenderer() {}, registerMarkdownTransformer(fn: any) { transformer = fn; }, registerMessageRenderer() {} } as any, view, () => true);
  const document = new Container(), ui = { children: [document] } as any;
  const message = (text: string, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra } as any);
  const row = (source: any) => new AssistantMessageComponent(source, false, undefined, undefined, undefined, [transformer]);
  for (const source of [message("First paragraph.\n\nSecond paragraph."), message("```\n \n\n```"), message("Hidden partial text", { stopReason: "error", errorMessage: "Visible failure detail" })]) {
    if (source.stopReason === "error") view.rootText(source.content, true);
    document.addChild(row(source));
  }
  const before = document.render(80);
  view.bind(ui); view.bind(ui);
  expect(document.render(80)).toEqual(before);
  const hidden = message("Newly appended backend reply"); view.rootText(hidden.content, true);
  document.addChild(row(hidden));
  expect(document.render(80)).toEqual(before);
  view.restore([{ teamId: "saved", from: "otter", kind: "message", text: "Reply", body: hidden.content[0].text, backend: true, nativeTexts: view.rootText(hidden.content, true) }]);
  expect(document.render(80).some((line) => stripTerminalSequences(line).includes(hidden.content[0].text))).toBe(false);
  const compactHeight = document.render(80).length;
  view.dispose();
  expect(document.render(80)).toHaveLength(compactHeight + 1);
});

test("filtered feed anchors collapse their host spacer without changing unrelated custom entries", () => {
  initTheme("dark", false);
  const view = new FeedView(), renderers = new Map<string, any>(), document = new Container();
  registerActivityRenderer({ registerEntryRenderer: (type: string, render: any) => renderers.set(type, render) } as any, view);
  view.append({ teamId: "team", from: "maple", kind: "message", text: "Reply", body: "A visible peer reply", segment: "one" });
  const entry = new CustomEntryComponent({ customType: FEED_ENTRY, data: { segment: "one" } } as any, renderers.get(FEED_ENTRY));
  document.addChild(entry);
  document.addChild(new CustomEntryComponent({ customType: "unrelated-empty-entry" } as any, () => new Container()));
  view.bind({ children: [document] } as any);
  const visible = document.render(80);
  view.select("otter"); expect(document.render(80)).toEqual([""]);
  view.select(); expect(document.render(80)).toEqual(visible);
  view.dispose();
  view.select("otter"); expect(document.render(80)).toEqual(["", ""]);
});


test("fullscreen history fills the recovered rows directly above the compact activity table", () => {
  initTheme("dark", false);
  const view = new FeedView(); let transformer: any;
  suppressNativeFeed({ registerToolRenderer() {}, registerMarkdownTransformer(fn: any) { transformer = fn; }, registerMessageRenderer() {} } as any, view, () => true);
  const document = new Container(), table = new Container();
  document.addChild(new Text(Array.from({ length: 100 }, (_, i) => `HISTORY-${i}`).join("\n") + "\nSHARED-FEED-END", 0, 0));
  for (let i = 0; i < 16; i++) {
    const content = [{ type: "text", text: `Hidden backend reply ${i}` }]; view.rootText(content, true);
    document.addChild(new AssistantMessageComponent({ role: "assistant", content, stopReason: "stop" } as any, false, undefined, undefined, undefined, [transformer]));
  }
  table.addChild(new Spacer(1)); table.addChild(new Text("Agent  State\njay    Ready\nraven  Ready", 0, 0));
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(), widgetsAbove: table, editor: new Text("INPUT\n\n", 0, 0), footer: new Text("STATUS", 0, 0), scrollbar: "hidden" });
  view.bind({ children: [document] } as any);
  for (const [width, height] of [[100, 40], [50, 24]]) {
    const frame = renderLayoutFrame(viewport.root, width!, height!, () => {}).lines.map((line) => stripTerminalSequences(line).trimEnd());
    expect(frame).toHaveLength(height!);
    const feed = frame.indexOf("SHARED-FEED-END"), overview = frame.indexOf("Agent  State");
    expect(feed).toBeGreaterThan(0); expect(overview - feed).toBe(2);
    expect(frame.slice(0, feed).some((line) => line.startsWith("HISTORY-"))).toBe(true);
    expect(frame).toContain("INPUT"); expect(frame).toContain("STATUS");
  }
  view.dispose();
});

test("malformed action loops are bounded per member without treating denials or command errors as malformed", () => {
  const failures = new ActionFailures();
  const invalid = { type: "tool_execution_end", toolName: "approved_action", isError: true, result: { content: [{ type: "text", text: 'Validation failed for tool "approved_action": arguments must be object' }] } } as any;
  expect(failures.observe("mint", invalid)).toBe(false);
  expect(failures.observe("brook", invalid)).toBe(false);
  expect(failures.observe("mint", invalid)).toBe(false);
  expect(failures.observe("mint", invalid)).toBe(true);
  expect(failures.observe("brook", { ...invalid, result: { details: { technicalFailure: true, technicalStage: "request validation" } } })).toBe(false);
  expect(failures.observe("brook", { ...invalid, result: { content: [{ type: "text", text: "Reviewer denied" }] } })).toBe(false);
  expect(failures.observe("brook", invalid)).toBe(false);
  expect(failures.observe("brook", { ...invalid, result: { content: [{ type: "text", text: "Command exited with code 1" }] } })).toBe(false);
  expect(failures.observe("brook", invalid)).toBe(false);
});
