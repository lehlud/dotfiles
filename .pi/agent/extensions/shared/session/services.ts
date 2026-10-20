import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OperatorInputKind } from "../contracts/operator-input.ts";

import type { QuestionClient } from "../contracts/questions.ts";
import type { Goal } from "../contracts/goal.ts";
import type { SubagentMode, SubagentActivity } from "../contracts/subagents.ts";

export type ActionLease = {
  scope?: { planId?: string; name: string; task: string; resources: string[]; waiting?: boolean };
  assertCurrent(): void;
  release(): void;
};

/** Trusted session capabilities; models cannot inspect or mutate this registry. */
export type SessionServices = {
  delegationMode?: SubagentMode;
  acquireActionLease?: () => ActionLease;
  subagentsBusy?: () => boolean;
  subagentRevision?: () => number;
  stopSubagents?: () => Promise<void>;
  subagentOperatorInput?: (text: string) => Promise<void>;
  publishSubagentActivity?: (record: SubagentActivity) => void;
  questions?: (owner: string) => QuestionClient;
  recordOperatorInput?: (text: string, kind: OperatorInputKind) => void;
  broadcastConversationMessage?: (customType: string, text: string) => void;
  broadcastOperatorInput?: (text: string, kind: OperatorInputKind) => void;
  setAgentGoal?: (text: string, signal?: AbortSignal) => Promise<Goal>;
  fastMode?: () => boolean;
  operatorGoal?: () => string | undefined;
  operatorGoalId?: () => string | undefined;
  goalInstruction?: () => string | undefined;
  cleanup?: () => Promise<void>;
  mailbox?: {
    name: string;
    active(): boolean;
    audit(data: Record<string, unknown>): void;
    beginAction?(): ActionLease;
  };
  peersBusy?: () => boolean;
  peerRevision?: () => number;
  interruptGoal?: (reason?: string) => void;
  resetProgress?: () => void;
  resumeGoal?: (ctx: ExtensionCommandContext) => Promise<boolean>;
  continueTeam?: (instruction: string) => void;
  flushOperatorInputs?: () => void;
  operatorInputKind?: (text: string) => OperatorInputKind | undefined;
  forwardOperatorInput?: (text: string, kind: OperatorInputKind) => void;
  stopTeam?: () => Promise<void>;
};

// Compiled Pi loads each extension with an independent module cache. A shared
// process registry preserves session identity across those copies and reloads.
const sharedKey = Symbol.for("pi.auto-approval.session-services.v1");
const shared = globalThis as typeof globalThis & { [sharedKey]?: WeakMap<object, SessionServices> };
const sessions = (shared[sharedKey] ??= new WeakMap<object, SessionServices>());

export function sessionServices(ctx: Pick<ExtensionContext, "sessionManager">): SessionServices {
  let services = sessions.get(ctx.sessionManager);

  if (!services) {
    services = {};
    sessions.set(ctx.sessionManager, services);
  }

  return services;
}
