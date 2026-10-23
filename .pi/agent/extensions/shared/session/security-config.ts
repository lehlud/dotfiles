import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Config } from "../configuration/schemas.ts";

// An agent may edit setup on disk, but cannot activate its own security changes.
const key = Symbol.for("pi.security-config.pinned.v1");
const runtime = globalThis as typeof globalThis & { [key]?: Map<string, Config> };
const pinned = (runtime[key] ??= new Map<string, Config>());
export const pinnedSecurityConfig = () => structuredClone(pinned.get(getAgentDir()));

export function pinSecurityConfig(config: Config) {
  if (!pinned.has(getAgentDir())) pinned.set(getAgentDir(), structuredClone(config));
}
