import { CIP_HOST } from "./host-keys.ts";
import { isIP } from "node:net";
import type { RemoteTarget } from "../shared/contracts/remote.ts";

export function hostname(value: string) {
  if (isIP(value)) return value;

  if (
    value.length > 253 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) ||
    value.includes("..")
  )
    throw new Error("Use a literal DNS hostname or IP address");

  return value;
}

export function parseTarget(input: string): Pick<RemoteTarget, "user" | "host" | "folder"> {
  const match = /^([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})@([^:\s]+):(.+)$/.exec(input.trim());

  if (!match || /[\u0000-\u001f\u007f]/.test(input))
    throw new Error("Use /remote user@host:folder; relative folders resolve under the remote home");

  const [, user, host, folder] = match;

  if (folder.startsWith("~") && folder !== "~" && !folder.startsWith("~/"))
    throw new Error("Other-user home expansion is unsupported");

  return { user, host: hostname(host), folder };
}

export function label(target: Pick<RemoteTarget, "user" | "host" | "folder">) {
  return `${target.user}@${target.host}:${target.folder}`;
}

export function validateTarget(value: unknown): RemoteTarget {
  if (!value || typeof value !== "object") throw new Error("Invalid saved remote workspace");

  const item = value as RemoteTarget;

  if ([item.user, item.host, item.folder, item.root].some((part) => typeof part !== "string"))
    throw new Error("Invalid saved remote workspace");

  const parsed = parseTarget(label(item));

  if (
    !item.root?.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(item.root) ||
    !["bwrap", "confirmed-account"].includes(item.isolation) ||
    typeof item.knownHosts !== "string" ||
    !item.knownHosts.trim() ||
    item.knownHosts.length > 65536
  )
    throw new Error("Invalid saved remote workspace");

  if (
    item.isolation === "confirmed-account" &&
    (item.confirmation?.source !== "operator-ui" ||
      typeof item.confirmation.reason !== "string" ||
      item.confirmation.reason.length > 600)
  )
    throw new Error("Unsandboxed remote execution requires operator UI confirmation");

  if (
    item.cip &&
    (!CIP_HOST.test(item.host) ||
      !/^cip-[1-4]$/.test(item.cip.node) ||
      typeof item.cip.gpu !== "boolean" ||
      !item.cip.home?.startsWith("/") ||
      item.cip.tmp !== "/proj/ciptmp" ||
      /[\u0000-\u001f\u007f]/.test(item.cip.home))
  )
    throw new Error("Invalid saved CIP target");

  return {
    ...parsed,
    root: item.root,
    isolation: item.isolation,
    knownHosts: item.knownHosts,
    confirmation: item.confirmation,
    ...(item.cip ? { cip: structuredClone(item.cip) } : {}),
  };
}
