import { Type, type Static } from "typebox";

export const sandboxRequestSchema = Type.Object(
  {
    projectFiles: Type.Optional(
      Type.Union([Type.Literal("read"), Type.Literal("write")], {
        description:
          "For credential_exec only: request current-project files read-only or writable for this one command. Omit for no project mount; sandbox.paths can grant only selected files instead. All accesses require independent approval.",
      }),
    ),
    gitConfig: Type.Optional(
      Type.Boolean({
        description:
          "For tool git only: request public global Git settings and identity read-only for this single argv-only command. No credentials, helpers, aliases or executable configuration. Independent approval is required.",
      }),
    ),
    tools: Type.Optional(
      Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$" }), {
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
        description:
          "Local tool bundles, e.g. node for nvm/npm/npx or sqlmap. Host installations stay read-only; caches and updates use session-private /tmp. Network access must be requested separately.",
      }),
    ),
    paths: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({ pattern: "^/", minLength: 1 }),
            access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 32 },
      ),
    ),
    network: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("host")])),
    environment: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
        Type.String({ maxLength: 16384 }),
        { maxProperties: 64, additionalProperties: false },
      ),
    ),
    executableSearchPaths: Type.Optional(
      Type.Array(Type.String({ pattern: "^/", minLength: 1 }), { minItems: 1, maxItems: 16 }),
    ),
    limits: Type.Optional(
      Type.Object(
        {
          executionTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86400000 })),
          maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 268435456 })),
          tmpBytes: Type.Optional(Type.Integer({ minimum: 1048576, maximum: 4294967296 })),
          memoryMiB: Type.Optional(Type.Integer({ minimum: 64, maximum: 65536 })),
          cpus: Type.Optional(Type.Number({ minimum: 0.1, maximum: 64 })),
          pids: Type.Optional(Type.Integer({ minimum: 16, maximum: 65536 })),
        },
        { additionalProperties: false, minProperties: 1 },
      ),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

export type SandboxRequest = Static<typeof sandboxRequestSchema>;

export type Request = {
  tool: string;
  arguments: Record<string, unknown>;
  goal: string;
  justification: string;
  sandbox?: SandboxRequest;
  network?: boolean;
};

export function normalizeNetworkFlag(request: Request): Request {
  if (request.network === undefined) return request;

  if (!["bash", "powershell", "credential_exec"].includes(request.tool))
    throw new Error(
      "The one-command network flag is only supported for shell and credential actions",
    );

  const mode = request.network ? "host" : "none";

  if (request.sandbox?.network !== undefined && request.sandbox.network !== mode)
    throw new Error("Conflicting one-command network flag and sandbox network request");

  const { network: _flag, ...action } = request;

  return { ...action, sandbox: { ...request.sandbox, network: mode } };
}

