import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionServices } from "../contracts/session-services.ts";

export type { SessionServices, ActionLease } from "../contracts/session-services.ts";

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
