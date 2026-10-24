import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Reviewer } from "./protocol.ts";
import type { LookupObserver } from "./original-turn.ts";
import type { AvailabilityNotice } from "../providers/availability.ts";
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
  cachePrefix?: string;
  goalCheck?: true;
  promptSources?: Map<string, string>;
  compressionUsage?: Usage;
};

export type ReviewRegistry = Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "streamSimple"> &
  Partial<Pick<ModelRegistry, "getAll" | "getProvider">>;

export type ReviewProcessing = { fastMode?: () => boolean };

export type ReviewAttempt = Reviewer & {
  status: "failed" | "invalid" | "approve" | "deny";
  reason: string;
};

export type ReviewObserver = LookupObserver & {
  start(candidate: Reviewer): void;
  finish(): void;
  failed(attempt: ReviewAttempt): void;
  retry?(event: AvailabilityNotice): void;
};
