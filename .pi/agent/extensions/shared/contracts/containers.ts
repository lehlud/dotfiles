import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Request } from "./action.ts";

export type ContainerWorkspace = {
  path: string;
  cwd: string;
  bindings: string[];
  readOnlyBindings?: string[];
  masked: { path: string; directory: boolean }[];
};

export type ContainerPrepared = {
  plan: Record<string, unknown>;
  assertCurrent(): Promise<void>;
  execute(signal?: AbortSignal): Promise<AgentToolResult<any>>;
};

export type ContainerFile = { path: string; source: string; sha256: string };

export type ContainerReader = (
  names: string[],
) => Promise<(ContainerFile | { errorCode: string })[]>;

export type ContainerAccess = {
  prepare(
    request: Request,
    workspace: ContainerWorkspace,
    read: ContainerReader,
  ): Promise<ContainerPrepared>;
};

const argv = Type.Array(Type.String({ maxLength: 16384, pattern: "^[^\\u0000]*$" }), {
  minItems: 1,
  maxItems: 96,
});

export const containerTool: ToolDefinition<any, any> = {
  name: "container_exec",
  label: "Reviewed container job",
  description:
    "Run exact Docker/Podman argv through the operator's engine after independent approval. Use argv for one command or commands for a sequential batch (for example Compose startup, tests and teardown). The engine control channel stays private; no agent shell receives its socket or Lubox host-exec credentials. Project files require sandbox.projectFiles read/write, or selected sandbox.paths. Workloads use temporary owned containers/networks and are cleaned up at the end; images and project writes may persist. Engine-wide administration, host escapes and access to protected host files are unavailable. Request sandbox.network host for connectivity. Enforced memory/CPU/PID budgets use OCI workload limits, without requiring a local cgroupRoot setting.",
  parameters: Type.Union([
    Type.Object(
      {
        engine: Type.Optional(
          Type.Union([Type.Literal("auto"), Type.Literal("docker"), Type.Literal("podman")]),
        ),
        argv,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        engine: Type.Optional(
          Type.Union([Type.Literal("auto"), Type.Literal("docker"), Type.Literal("podman")]),
        ),
        commands: Type.Array(argv, { minItems: 1, maxItems: 16 }),
      },
      { additionalProperties: false },
    ),
  ]),
  renderCall(args: any, theme, context) {
    const lines = (args.commands ?? [args.argv ?? []]).map(
      (argv: string[]) => `${args.engine ?? "container"} ${JSON.stringify(argv)}`,
    );
    const text = lines.join("\n");

    return new Text(
      theme.fg(
        "toolTitle",
        context.expanded ? text : text.slice(0, 300) + (text.length > 300 ? " … (ctrl+o)" : ""),
      ),
      0,
      0,
    );
  },
  async execute(): Promise<never> {
    throw new Error("Container jobs require approved_action");
  },
};
