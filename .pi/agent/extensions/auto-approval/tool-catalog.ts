import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sandboxRequestSchema } from "../shared/contracts/action.ts";
import { webTools } from "../web-research/index.ts";
import { writingCheckTool } from "../public-writing/index.ts";
import { credentialCommandTool } from "./credential-command.ts";
import { tunnelTool } from "../shared/contracts/remote.ts";
import { gitTool } from "./git-command.ts";

export const TOOL_NAME = "approved_action";
export const factories = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
  websearch: (_cwd: string) => webTools.websearch,
  webfetch: (_cwd: string) => webTools.webfetch,
  writing_check: (_cwd: string) => writingCheckTool,
  credential_exec: (_cwd: string) => credentialCommandTool,
  git: (_cwd: string) => gitTool,
  remote_tunnel: (_cwd: string) => tunnelTool,
};

export type ToolName = keyof typeof factories;

const toolNames = Object.keys(factories) as ToolName[];
export const definitions = Object.fromEntries(
  toolNames.map((name) => [name, factories[name](process.cwd())]),
) as Record<ToolName, ToolDefinition<any, any>>;
export const strictParameters = Type.Union(
  toolNames.map((name) =>
    Type.Object(
      {
        tool: Type.Literal(name),
        arguments: definitions[name].parameters,
        goal: Type.String({
          minLength: 1,
          maxLength: 4000,
          description: "Current concrete goal, tied to the real user's request.",
        }),
        justification: Type.String({
          minLength: 1,
          maxLength: 4000,
          description: "Why this exact action is needed now; explain side effects and scope.",
        }),
        sandbox: Type.Optional(sandboxRequestSchema),
        ...(["bash", "powershell", "credential_exec"].includes(name)
          ? {
              network: Type.Optional(
                Type.Boolean({
                  description:
                    "Request one-command network access (true) or explicitly stay offline (false). Independent approval is required before execution; expires when this action ends.",
                }),
              ),
            }
          : {}),
      },
      { additionalProperties: false },
    ),
  ),
);
const argumentSchemas = JSON.stringify(
  Object.fromEntries(toolNames.map((name) => [name, definitions[name].parameters])),
);
// A root object with an enum works across providers that mishandle root unions.
// Tool-specific requirements remain mandatory in the local strict validator.
export const parameters = Type.Object(
  {
    tool: Type.String({ enum: toolNames }),
    arguments: Type.Union([
      Type.Object(
        {},
        {
          additionalProperties: true,
          description: `An object following the selected tool's schema. Tool argument schemas: ${argumentSchemas}`,
        },
      ),
      Type.String({
        maxLength: 1048576,
        description:
          "A JSON-encoded arguments object is also accepted and decoded before strict validation and review. Never a bare command string.",
      }),
    ]),
    goal: Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "Current concrete goal, tied to the real user's request.",
    }),
    justification: Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "Why this exact action is needed now; explain side effects and scope.",
    }),
    sandbox: Type.Optional(sandboxRequestSchema),
    network: Type.Optional(
      Type.Boolean({
        description:
          "Request network for this one shell/credential action only; independently reviewed.",
      }),
    ),
  },
  { additionalProperties: false },
);
