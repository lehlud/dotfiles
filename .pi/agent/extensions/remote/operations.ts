import { createHash, randomUUID } from "node:crypto";
import type { Request } from "../shared/contracts/action.ts";
import {
  REMOTE_TOOLS,
  type RemotePrepared,
  type RemoteTarget,
} from "../shared/contracts/remote.ts";
import type { Tunnels } from "./tunnels.ts";
import { forwarding } from "./tunnels.ts";
import { remoteCall } from "./client.ts";
import { label } from "./target.ts";

export function executionTimeout(request: Request) {
  const timeout =
    request.sandbox?.limits?.executionTimeoutMs ??
    (typeof request.arguments.timeout === "number" ? request.arguments.timeout * 1000 : 120000);

  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 82800000)
    throw new Error("Remote actions require a positive deadline of at most 23 hours");

  return timeout;
}

export function validateRemoteRequest(request: Request, target: RemoteTarget) {
  if (request.sandbox?.cip && !target.cip) throw new Error("CIP node selection requires /cip mode");

  if (!REMOTE_TOOLS.has(request.tool)) throw new Error("Unsupported remote tool");

  const sandbox = request.sandbox ?? {};

  if (
    (sandbox.paths && !target.cip) ||
    sandbox.tools ||
    sandbox.executableSearchPaths ||
    sandbox.projectFiles
  )
    throw new Error(
      "Remote actions use remote-installed tools and the selected folder; local bundles, extra mounts and project credential mounts are unavailable",
    );

  const limits = sandbox.limits ?? {};

  executionTimeout(request);

  if (
    limits.memoryMiB !== undefined ||
    limits.cpus !== undefined ||
    limits.pids !== undefined ||
    limits.tmpBytes !== undefined
  )
    throw new Error(
      "Remote aggregate memory/CPU/PID/tmp quotas are not available; required limits cannot be dropped",
    );

  if ((limits.maxOutputBytes ?? 0) > 16777216 || (limits.executionTimeoutMs ?? 0) > 82800000)
    throw new Error("Remote actions support at most 16 MiB output and 23 hours per invocation");

  if (
    request.tool === "remote_tunnel" &&
    request.arguments.operation === "open" &&
    sandbox.network !== "host"
  )
    throw new Error("Opening an SSH tunnel requires explicit sandbox.network: host approval");

  if (target.isolation === "confirmed-account" && sandbox.network === "none")
    throw new Error(
      "This remote account has no network isolation. Explicit offline guarantees cannot be enforced; omit that constraint only when the operator's confirmed account mode is appropriate.",
    );

  if (request.tool === "remote_tunnel") {
    if (request.arguments.operation === "open") forwarding(request.arguments as any);

    if (sandbox.gitConfig || sandbox.environment)
      throw new Error("Tunnel requests do not accept Git configuration or environment");
  }
}

export function prepareRemote(
  target: RemoteTarget,
  request: Request,
  actor: string,
  readOnly: boolean,
  assertCurrent: () => void,
  tunnels: Tunnels,
  call = remoteCall,
): RemotePrepared {
  validateRemoteRequest(request, target);

  const action = randomUUID();
  const plan = {
    source: "executor-preflight",
    backend: "ssh",
    workspace: target.root,
    remote: {
      user: target.user,
      host: target.host,
      root: target.root,
      isolation: target.isolation,
      confirmation: target.confirmation,
      cip: target.cip,
      authentication: "local SSH agent only; never forwarded",
      hostVerification: "pinned OpenSSH known-host keys",
      hostKeysHash: createHash("sha256").update(target.knownHosts).digest("hex"),
      localTransport: "Linux bwrap; no Pi files or API credentials mounted",
      serverTrust:
        "remote host controls its own kernel and output; returned data is not authorization",
    },
    network:
      request.tool === "remote_tunnel"
        ? "SSH TCP forwarding; explicit reviewed endpoints"
        : target.isolation === "bwrap"
          ? (request.sandbox?.network ?? "none")
          : "remote-account networking; no OS enforcement",
    requested: request.sandbox ?? {},
    executionTimeoutMs:
      request.tool === "remote_tunnel"
        ? Math.min(15000, executionTimeout(request))
        : executionTimeout(request),
    maxOutputBytes: request.sandbox?.limits?.maxOutputBytes ?? 1048576,
    temporaryStorage: {
      path:
        target.isolation === "bwrap"
          ? "/tmp"
          : "session-private $TMPDIR; shell /tmp is the account's shared /tmp",
      private: true,
      lifetime: "remote actor session; cleanup best effort while reachable",
    },
    tunnel:
      request.tool === "remote_tunnel"
        ? { ...request.arguments, bindAddress: "127.0.0.1", agentForwarding: false }
        : undefined,
    gitConfiguration: request.sandbox?.gitConfig
      ? {
          publicSettingsOnly: true,
          readOnly: true,
          credentials: false,
          disclosure:
            "public Git identity/settings are sent to the selected remote host for this command",
        }
      : undefined,
    reconnect: "new SSH connection per action; never replay commands after ambiguous failure",
  };

  return {
    target,
    plan,
    assertCurrent,
    async execute(signal, gitConfig) {
      assertCurrent();

      if (request.tool === "remote_tunnel") {
        const args = request.arguments;

        if (args.operation === "open") {
          const result = await tunnels.open(
            target,
            args as any,
            actor,
            signal,
            Math.min(15000, executionTimeout(request)),
          );

          return {
            content: [
              {
                type: "text",
                text: `SSH tunnel ${result.id} · ${result.direction} · 127.0.0.1:${result.port} → ${result.destinationHost}:${result.destinationPort} · expires ${new Date(result.expires).toISOString()}`,
              },
            ],
            details: result,
          };
        }

        if (args.operation === "close") tunnels.close(String(args.id), actor);

        const result = tunnels.list(actor);

        return {
          content: [
            {
              type: "text",
              text:
                result
                  .map(
                    (item) =>
                      `${item.id} · ${item.state} · ${item.direction} · 127.0.0.1:${item.port} → ${item.destinationHost}:${item.destinationPort}`,
                  )
                  .join("\n") || "No SSH tunnels.",
            },
          ],
          details: result,
        };
      }

      const input = {
        operation: "execute",
        root: target.root,
        isolation: target.isolation,
        session: actor,
        action,
        request,
        readOnly,
        ...(target.cip ? { cip: target.cip } : {}),
        ...(gitConfig ? { gitConfig } : {}),
      };
      const output = request.sandbox?.limits?.maxOutputBytes ?? 1048576;

      try {
        const result = await call(target, input, signal, executionTimeout(request) + 15000, output);

        if (
          !Array.isArray(result?.content) ||
          result.content.some(
            (item: any) =>
              !item ||
              (item.type === "text"
                ? typeof item.text !== "string"
                : item.type !== "image" ||
                  typeof item.data !== "string" ||
                  !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mimeType)),
          ) ||
          (result.isError !== undefined && typeof result.isError !== "boolean")
        )
          throw new Error("Invalid remote tool result");

        return result;
      } catch (error) {
        await call(target, { operation: "cancel", session: actor, action }, undefined, 15000).catch(
          () => {},
        );

        throw new Error(
          `Remote operation on ${label(target)} failed; it may have had side effects. No replay; inspect remote state before retrying. ${error instanceof Error ? error.message : "Transport failed"}`,
        );
      }
    },
  };
}
