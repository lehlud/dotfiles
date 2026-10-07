import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  };
  peersBusy?: () => boolean;
  peerRevision?: () => number;
  teamSize?: number;
  refreshGoalStatus?: (ctx: ExtensionContext) => void;
  stopTeam?: () => Promise<void>;
};
const sessions = new WeakMap<object, SessionServices>();
export function sessionServices(ctx: Pick<ExtensionContext, "sessionManager">): SessionServices {
  let services = sessions.get(ctx.sessionManager);
  if (!services) { services = {}; sessions.set(ctx.sessionManager, services); }
  return services;
}
