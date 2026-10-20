import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_TOOL = "subagent";
export const PARENT_MAILBOX = "parent_mailbox";

export type SubagentMode = "review" | "work";

export type SubagentState = "starting" | "running" | "idle" | "failed" | "killed" | "timed-out";

export type SubagentResult = {
  id: string;
  name: string;
  task: string;
  mode: SubagentMode;
  state: SubagentState;
  report?: string;
};

export type SubagentActivity = {
  name: string;
  title: string;
  body?: string;
  diff?: string;
  color: number;
};

export function availableSubagentTools(pi: ExtensionAPI): string[] {
  const names = new Set(pi.getAllTools?.().map((tool) => tool.name));

  return [SUBAGENT_TOOL, PARENT_MAILBOX].filter((name) => names.has(name));
}

/** Review workers inspect data only; arbitrary execution is not a read-only operation. */
export function assertDelegatedAction(
  mode: SubagentMode | undefined,
  request: {
    tool: string;
    sandbox?: { paths?: { access: string }[]; projectFiles?: string };
  },
) {
  if (mode !== "review") return;

  if (
    !["read", "ls", "find", "grep", "websearch", "webfetch", "writing_check"].includes(request.tool)
  )
    throw new Error(
      "Read-only review subagents cannot execute commands or modify files; delegate execution separately in work mode",
    );

  if (
    request.sandbox?.paths?.some((path) => path.access === "write") ||
    request.sandbox?.projectFiles === "write"
  )
    throw new Error("Read-only review subagents cannot request writable file grants");
}
