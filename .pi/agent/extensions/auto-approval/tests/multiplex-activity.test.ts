import { expect, test } from "bun:test";
import { TeamActivity, ACTIVITY_ENTRY, ACTIVITY_WIDGET, registerActivityRenderer } from "../../multiplex/activity.ts";

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
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
  expect(frames.at(-1)?.join("\n")).toContain("maple · Running bash, mailbox");
  activity.observe("maple", { type: "tool_execution_end", toolCallId: "two", toolName: "mailbox", result: {}, isError: false });
  expect(frames.at(-1)?.join("\n")).toContain("maple · Running bash");
  activity.observe("maple", { type: "tool_execution_end", toolCallId: "one", toolName: "approved_action", result: { content: [{ type: "text", text: "failed build" }] }, isError: true });
  activity.observe("hare", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "LIVE-PREVIEW" }] }, assistantMessageEvent: { type: "text_delta" } } as any);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(frames.at(-1)?.join("\n")).toContain("hare · Writing · LIVE-PREVIEW");
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
  registerActivityRenderer({ registerEntryRenderer(type: string, value: any) { expect(type).toBe(ACTIVITY_ENTRY); render = value; } } as any);
  const data = { teamId: "team", from: "maple", kind: "tool-end", text: "bash · Finished", body: `\x1b[2J${Array.from({ length: 8 }, (_, i) => `line-${i}`).join("\n")}` };
  const compact = render({ data }, { expanded: false }, theme).render(1000).join("\n");
  expect(compact).toContain("Agent · maple · bash · Finished");
  expect(compact).not.toContain("\x1b[2J"); expect(compact).not.toContain("line-7"); expect(compact).toContain("ctrl+o to expand");
  expect(render({ data }, { expanded: true }, theme).render(1000).join("\n")).toContain("line-7");
});
