import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { sessionServices } from "../shared/session/services.ts";

export const PROGRESS_TYPE = "conversation-progress-instruction";
export const PROGRESS_WARNING =
  "Recent inspection actions returned only information already observed in this task. Use the existing evidence and choose a concrete next implementation, validation or focused investigation. Do not repeat baseline status, hashes or progress-file checks without a new dependency. This is a progress reminder, not action approval or permission to bypass a denial.";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Conservative recognition only for loop detection; never an access decision. */
export function inspection(tool: string, args: Record<string, unknown>): boolean {
  if (["read", "grep", "find", "ls", "websearch", "webfetch"].includes(tool)) return true;

  if (tool !== "bash" || typeof args.command !== "string") return false;

  const command = args.command;

  // Complex shell programs are work, not a parsed or rewritten inspection.
  if (/[\n`$<>\\]/.test(command) || /\bsed\b.*(?:-i|--in-place)|--output\b/.test(command))
    return false;

  let quote = "",
    part = "";
  const parts: string[] = [];

  for (const char of command) {
    if ((char === "'" || char === '"') && (!quote || quote === char)) quote = quote ? "" : char;

    if (!quote && /[;&|]/.test(char)) {
      if (part.trim()) parts.push(part.trim());

      part = "";
    } else part += char;
  }

  if (quote) return false;

  if (part.trim()) parts.push(part.trim());

  return (
    !!parts.length &&
    parts.every((text) =>
      /^(?:git\s+(?:status|diff|log|show|rev-parse)\b|(?:sha256sum|shasum|tail|head|cat|sed|ls|rg|file|readelf|objdump)\b|command\s+-v\b|zig\s+version\b|true$)/.test(
        text,
      ),
    )
  );
}

/** Bounded evidence cache catches reordered/subset inspections without shell IO. */
export class InspectionProgress {
  private seen = new Set<string>();
  repeats = 0;
  reset() {
    this.seen.clear();
    this.repeats = 0;
  }

  observe(
    tool: string,
    args: Record<string, unknown>,
    output: string,
  ): "fresh" | "repeat" | "warn" | "halt" {
    if (!inspection(tool, args) || Buffer.byteLength(output) > 65536) {
      this.reset();

      return "fresh";
    }

    const scope = tool === "bash" ? tool : `${tool}:${JSON.stringify(args)}`;
    const lines = output.split("\n").filter(Boolean);
    const values = tool === "bash" ? (lines.length ? lines : [JSON.stringify(args)]) : [output];
    const hashes = values.map((line) => digest(`${scope}\0${line}`));
    const fresh = hashes.some((hash) => !this.seen.has(hash));

    for (const hash of hashes) {
      this.seen.add(hash);

      if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    }

    this.repeats = fresh ? 0 : this.repeats + 1;

    return this.repeats >= 8 ? "halt" : this.repeats === 4 ? "warn" : fresh ? "fresh" : "repeat";
  }
}

export function registerProgress(
  pi: ExtensionAPI,
  halted?: (ctx: ExtensionContext, reason: string) => void,
) {
  const progress = new InspectionProgress();
  let goal: string | undefined,
    warning = false,
    stopped = false;
  const reset = () => {
    progress.reset();
    warning = false;
    stopped = false;
  };

  pi.on("session_start", (_event, ctx) => {
    reset();
    goal = undefined;
    sessionServices(ctx).resetProgress = reset;
  });

  pi.on("session_tree", (_event, ctx) => {
    reset();
    goal = undefined;
    sessionServices(ctx).resetProgress = reset;
  });

  pi.on("session_shutdown", reset);
  pi.on("input", (event) => {
    if (event.source !== "extension") reset();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const current = sessionServices(ctx).operatorGoal?.();

    if (!current || current !== goal) reset();

    goal = current;
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (entry) => entry.role !== "custom" || entry.customType !== PROGRESS_TYPE,
    );

    if (warning)
      messages.push({
        role: "custom",
        customType: PROGRESS_TYPE,
        content: PROGRESS_WARNING,
        display: false,
        timestamp: Date.now(),
      });

    return { messages };
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    if (stopped || event.toolName !== "approved_action") return;

    const receipt = event.details as any,
      action = receipt?.approval?.action;

    if (receipt?.approval?.decision !== "approve" || !action?.arguments) return;

    const output = event.content
      .slice(["websearch", "webfetch"].includes(action.tool) ? 0 : 1)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const result = progress.observe(action.tool, action.arguments, output);

    if (result === "fresh") warning = false;

    if (result === "warn") {
      warning = true;

      try {
        pi.appendEntry("conversation-progress-warning", { repeats: progress.repeats });
      } catch {
        /* The bounded halt still applies. */
      }
    }

    if (result !== "halt") return;

    stopped = true;

    const reason =
      "Progress guard paused repeated unchanged inspections after eight repetitions. Goal completion is unconfirmed. Choose a concrete next step, then use /goal resume or send new operator guidance.";

    try {
      pi.appendEntry("conversation-progress-halt", { repeats: progress.repeats, reason });
    } catch {
      /* Stop even if logging fails. */
    }

    if (halted) {
      halted(ctx, reason);

      return;
    }

    try {
      sessionServices(ctx).interruptGoal?.(reason);
    } catch {
      /* Paused in memory before persistence. */
    }

    const stopping = sessionServices(ctx).stopTeam?.();

    ctx.abort();
    ctx.ui.notify(reason, "warning");
    void stopping?.catch(() =>
      ctx.ui.notify("Team cleanup failed after progress halt; inspect the runtime.", "error"),
    );
  });
}
