import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OperatorInputKind } from "./operator-input.ts";
import type { QuestionClient } from "./questions.ts";
import type { Goal } from "./goal.ts";
import type { SubagentMode, SubagentActivity } from "./subagents.ts";
import type { CacheLineage } from "../providers/cache-affinity.ts";
import type { ContainerAccess } from "./containers.ts";
import type { RemoteSession } from "./remote.ts";
import type { Reviewer } from "../review/protocol.ts";

export type ActionLease = {
  scope?: { planId?: string; name: string; task: string; resources: string[]; waiting?: boolean };
  assertCurrent(): void;
  release(): void;
};

export interface ExecutionServices {
  remote?: RemoteSession;
  containers?: ContainerAccess;
  cleanup?: () => Promise<void>;
  delegationMode?: SubagentMode;
  acquireActionLease?: () => ActionLease;
}

export interface ModelServices {
  fastMode?: () => boolean;
  workingModel?: () => Reviewer | undefined;
  desiredReviewer?: () => Reviewer | undefined;
  activeReviewer?: () => Reviewer | undefined;
  inlineModelStatus?: boolean;
  cacheLineage?: () => CacheLineage | undefined;
  parentCacheLineage?: () => CacheLineage | undefined;
  prepareProviderResume?: () => void;
}

export interface ConversationServices {
  questions?: (owner: string) => QuestionClient;
  recordOperatorInput?: (text: string, kind: OperatorInputKind) => void;
  terminalInterruptOwned?: () => boolean;
  resetProgress?: () => void;
  flushOperatorInputs?: () => void;
  operatorInputKind?: (text: string) => OperatorInputKind | undefined;
  forwardOperatorInput?: (text: string, kind: OperatorInputKind) => void;
}

export interface GoalServices {
  setAgentGoal?: (
    text: string,
    signal?: AbortSignal,
    update?: (text: string) => void,
  ) => Promise<Goal>;
  operatorGoal?: () => string | undefined;
  operatorGoalId?: () => string | undefined;
  goalInstruction?: () => string | undefined;
  interruptGoal?: (reason?: string) => void;
  resumeGoal?: (ctx: ExtensionCommandContext) => Promise<boolean>;
}

export interface TeamServices {
  mailbox?: {
    name: string;
    active(): boolean;
    audit(data: Record<string, unknown>): void;
    beginAction?(): ActionLease;
  };
  peersBusy?: () => boolean;
  peerRevision?: () => number;
  continueTeam?: (instruction: string) => void;
  stopTeam?: () => Promise<void>;
  broadcastConversationMessage?: (customType: string, text: string) => void;
  broadcastOperatorInput?: (text: string, kind: OperatorInputKind) => void;
}

export interface SubagentServices {
  subagentsBusy?: () => boolean;
  subagentRevision?: () => number;
  stopSubagents?: () => Promise<void>;
  subagentOperatorInput?: (text: string) => Promise<void>;
  publishSubagentActivity?: (record: SubagentActivity) => void;
}

/** Feature-owned callbacks shared by one trusted session; never model-facing tools. */
export type SessionServices = ExecutionServices &
  ModelServices &
  ConversationServices &
  GoalServices &
  TeamServices &
  SubagentServices;
