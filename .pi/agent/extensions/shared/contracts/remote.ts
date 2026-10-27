import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Request } from "./action.ts";
import type { Config } from "../configuration/schemas.ts";

export const REMOTE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "ls",
  "find",
  "grep",
  "git",
  "remote_tunnel",
  "cip_nodes",
]);

export type RemoteTarget = {
  user: string;
  host: string;
  folder: string;
  root: string;
  isolation: "bwrap" | "confirmed-account";
  knownHosts: string;
  confirmation?: { source: "operator-ui"; reason: string };
  cip?: { node: string; gpu: boolean; home: string; tmp: string };
};

export type RemotePrepared = {
  target: RemoteTarget;
  plan: Record<string, unknown>;
  assertCurrent(): void;
  execute(signal?: AbortSignal, gitConfig?: string): Promise<AgentToolResult<any>>;
};

export type RemoteSession = {
  target(): RemoteTarget | undefined;
  prepare(
    request: Request,
    config: Config,
    actor: string,
    reviewOnly: boolean,
    signal?: AbortSignal,
  ): RemotePrepared | Promise<RemotePrepared>;
  context?(): string;
  cleanup(actor: string): Promise<void>;
};

export const tunnelTool = {
  name: "remote_tunnel",
  label: "Reviewed SSH tunnel",
  description:
    "Open, list or close an SSH TCP tunnel for the operator-selected remote workspace. Opening always needs independent approval. Local forwards expose a remote destination on local loopback; remote forwards expose a local destination on remote loopback. No wildcard listeners, SOCKS, Unix-socket forwarding or SSH-agent forwarding. Tunnels expire and close on interruption/session shutdown.",
  parameters: Type.Union([
    Type.Object(
      {
        operation: Type.Literal("open"),
        direction: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
        port: Type.Integer({ minimum: 1024, maximum: 65535 }),
        destinationHost: Type.String({ minLength: 1, maxLength: 253 }),
        destinationPort: Type.Integer({ minimum: 1, maximum: 65535 }),
        lifetimeSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 82800 })),
      },
      { additionalProperties: false },
    ),
    Type.Object({ operation: Type.Literal("list") }, { additionalProperties: false }),
    Type.Object(
      { operation: Type.Literal("close"), id: Type.String({ format: "uuid" }) },
      { additionalProperties: false },
    ),
  ]),
  async execute(): Promise<never> {
    throw new Error("SSH tunnels require approved_action");
  },
};

export const cipNodesTool = {
  name: "cip_nodes",
  label: "CIP workstation pool",
  description:
    "In /cip mode: list inventory, allocated slots and shared quotas; acquire up to four nodes, optionally choosing a workstation/GPU/RAM; release an idle slot. All requests use independent approval. Use returned slot IDs in sandbox.cip.node for commands; files are shared. Occupied nodes are replaced; interrupted commands are never replayed automatically. Keep resumable checkpoints in the shared workspace/ciptmp, never node-local /tmp.",
  parameters: Type.Union([
    Type.Object({ operation: Type.Literal("list") }, { additionalProperties: false }),
    Type.Object(
      {
        operation: Type.Literal("acquire"),
        host: Type.Optional(
          Type.String({ pattern: /^cip[0-9][a-z0-9-]*(\.cip\.cs\.fau\.de)?$/.source }),
        ),
        gpu: Type.Optional(Type.Boolean()),
        minCores: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
        minRamGiB: Type.Optional(Type.Integer({ minimum: 1, maximum: 2048 })),
        gpuModel: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { operation: Type.Literal("release"), node: Type.String({ pattern: "^cip-[1-4]$" }) },
      { additionalProperties: false },
    ),
  ]),
  async execute(): Promise<never> {
    throw new Error("CIP scheduling requires approved_action in /cip mode");
  },
};
