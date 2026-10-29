import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const JOB_TOOL = "job";
export const FOREGROUND_JOB_MS = 120_000;
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
    work: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1000,
        description: "Independent work to do meanwhile, if any. Otherwise join with job wait.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type JobSpec = { title: string; work?: string; toolCallId: string };

export type JobResult = Awaited<ReturnType<ToolDefinition<any, any>["execute"]>> & {
  isError?: boolean;
};

export type ForegroundResult = { result: JobResult } | { job: JobInfo };

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
  runForeground(
    spec: JobSpec,
    run: (signal: AbortSignal) => Promise<JobResult>,
    signal?: AbortSignal,
  ): Promise<ForegroundResult>;
  cancelAll(): Promise<void>;
  stop(): Promise<void>;
}

export function availableJobTools(pi: ExtensionAPI): string[] {
  return pi.getAllTools?.().some((tool) => tool.name === JOB_TOOL) ? [JOB_TOOL] : [];
}
