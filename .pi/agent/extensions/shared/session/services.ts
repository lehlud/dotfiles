import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ActionLease = {
  scope?: { planId?: string; name: string; task: string; resources: string[]; waiting?: boolean };
  assertCurrent(): void;
  release(): void;
};

/** Only extensions set these session-bound services; no model tool can access them. */
export type SessionServices = {
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

