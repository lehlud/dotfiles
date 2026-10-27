import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RemoteTarget } from "../shared/contracts/remote.ts";
import { remoteCall } from "./client.ts";
import { knownHostKeys } from "./ssh.ts";
import { label, parseTarget, validateTarget } from "./target.ts";

export type SelectionIO = { call: typeof remoteCall; keys: typeof knownHostKeys };

export const selectionIO: SelectionIO = { call: remoteCall, keys: knownHostKeys };

/** Only this operator command can confirm account-mode execution after a failed probe. */
export async function selectRemote(
  input: string,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  io: SelectionIO,
): Promise<RemoteTarget | undefined> {
  const reference =
    input ||
    (await ctx.ui.input("Remote workspace · SSH-agent authentication only", "user@host:folder", {
      signal,
    }));

  if (!reference) return;

  const target = parseTarget(reference);
  const knownHosts = await io.keys(target.host);
  const initial: RemoteTarget = { ...target, root: "/", isolation: "bwrap", knownHosts };
  const probe = await io.call(initial, { operation: "probe", folder: target.folder }, signal);

  return await resolveRemoteProbe(target, knownHosts, probe, ctx, signal);
}

export async function resolveRemoteProbe(
  target: Pick<RemoteTarget, "user" | "host" | "folder">,
  knownHosts: string,
  probe: any,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  consent?: RemoteTarget["confirmation"],
  scope?: string,
): Promise<RemoteTarget | undefined> {
  if (
    probe?.system !== "Linux" ||
    typeof probe.sandbox !== "boolean" ||
    typeof probe.root !== "string" ||
    !probe.root.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(probe.root)
  )
    throw new Error("Remote work requires Linux and Python 3 with a valid project directory");

  let confirmation: RemoteTarget["confirmation"] = probe.sandbox ? undefined : consent;

  if (!probe.sandbox && !confirmation) {
    if (!ctx.hasUI)
      throw new Error(
        "Remote sandbox unavailable; operator UI confirmation is required before account-mode execution",
      );

    const reason = String(probe.reason || "bwrap unavailable").slice(0, 600);
    const accepted = await ctx.ui.confirm(
      "Remote sandbox unavailable",
      [
        scope ?? label(target),
        `Directory: ${probe.root}`,
        `Remote diagnostic (untrusted DATA): ${JSON.stringify(reason)}`,
        "",
        "Proceed with Auto-Approval and the remote account's normal permissions?",
        "",
        "The folder is only the working directory.",
        "There will be no remote OS/filesystem/network isolation.",
        "",
        "API credentials stay local; SSH-agent forwarding remains disabled.",
        "Required unsupported resource/offline guarantees will be rejected.",
      ].join("\n"),
      { signal },
    );

    if (!accepted) return;

    confirmation = { source: "operator-ui", reason };
  }

  signal.throwIfAborted();

  return validateTarget({
    ...target,
    root: probe.root,
    isolation: confirmation ? "confirmed-account" : "bwrap",
    knownHosts,
    confirmation,
  });
}
