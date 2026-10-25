import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const JOB_TOOL = "job";
export const BACKGROUND_TOOLS = new Set([
  "bash",
  "powershell",
  "git",
  "credential_exec",
  "container_exec",
]);
export const backgroundSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 100 }),
    work: Type.String({
      minLength: 1,
      maxLength: 1000,
      description:
        "Independent useful work to do while this command runs. If only waiting, use foreground execution instead.",
    }),
  },
  { additionalProperties: false },
);

export type JobSpec = { title: string; work: string; toolCallId: string };

export type JobResult = Awaited<ReturnType<ToolDefinition<any, any>["execute"]>> & {
  isError?: boolean;
};

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

export type JobInfo = JobSpec & { id: string; state: JobState; started: number; finished?: number };

export type ActionResult = {
  toolCallId: string;
  content: JobResult["content"];
  details: unknown;
  isError?: boolean;
};

/** Session-owned supervisor. It cannot adopt arbitrary processes or grant permissions. */
export interface JobAccess {
  readonly busy: boolean;
  readonly revision: number;
  start(spec: JobSpec, run: (signal: AbortSignal) => Promise<JobResult>): JobInfo;
  cancelAll(): Promise<void>;
  stop(): Promise<void>;
}

export function availableJobTools(pi: ExtensionAPI): string[] {
  return pi.getAllTools?.().some((tool) => tool.name === JOB_TOOL) ? [JOB_TOOL] : [];
}
