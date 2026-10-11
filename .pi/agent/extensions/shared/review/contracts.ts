import type { AssistantMessage } from "@earendil-works/pi-ai";

export type Usage = AssistantMessage["usage"];
export type PromptRecord = {
  promptId: string;
  original: string;
  text: string;
  compressed: boolean;
  originalBytes: number;
  version: number;
  cacheHit: boolean;
  cacheKey?: string;
  reason?: string;
};
export type PreparedPrompts = { records: PromptRecord[]; usage?: Usage };
export type ReviewEnvelope = {
  requestId: string;
  fingerprint: string;
  text: string;
  promptSources?: Map<string, string>;
  compressionUsage?: Usage;
};
