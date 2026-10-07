// Runs inside the mandatory Docker or bwrap sandbox. No host fallback.
import {
  createBashToolDefinition, createPowerShellToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, createEditToolDefinition, createGrepToolDefinition,
  createFindToolDefinition, createLsToolDefinition, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { mkdir } from "node:fs/promises";
import { isWebTool, webTools } from "../web-research/index.ts";
import { executeWeb } from "../web-research/execute.ts";
import { writingCheckTool } from "../public-writing/index.ts";
import { credentialCommandTool, executeCredentialCommand } from "./credential-command.ts";
import { gitTool, executeGit } from "./git-command.ts";

const factories = {
  read: createReadToolDefinition, bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition, write: createWriteToolDefinition,
  edit: createEditToolDefinition, grep: createGrepToolDefinition,
  find: createFindToolDefinition, ls: createLsToolDefinition,
};
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 100000) throw new Error("Executor input limit exceeded");
  }
  const request = JSON.parse(input);
  await mkdir("/tmp/home", { recursive: true });
  let result;
  if (request.tool === "git") {
    if (!Check(gitTool.parameters, request.arguments)) throw new Error("Invalid Git arguments");
    result = await executeGit(request.arguments.argv, request.sandbox?.gitConfig === true, request.gitConfigReader);
  } else if (request.tool === "credential_exec") {
    if (!Check(credentialCommandTool.parameters, request.arguments)) throw new Error("Invalid credential command arguments");
    result = await executeCredentialCommand(request.credentialExecution);
  } else if (isWebTool(request.tool)) {
    const tool = webTools[request.tool as keyof typeof webTools];
    if (!Check(tool.parameters, request.arguments)) throw new Error("Invalid web executor arguments");
    result = await executeWeb(request);
  } else if (request.tool === "writing_check") {
    if (!Check(writingCheckTool.parameters, request.arguments)) throw new Error("Invalid writing check arguments");
    result = await writingCheckTool.execute("isolated", request.arguments, undefined, undefined, undefined as any);
  } else {
    if (!Object.hasOwn(factories, request.tool)) throw new Error("Unknown executor operation");
    const name = request.tool as keyof typeof factories;
    const tool = (name === "bash" ? createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }) : factories[name](process.cwd())) as ToolDefinition<any, any>;
    if (!Check(tool.parameters, request.arguments)) throw new Error("Invalid executor arguments");
    result = await tool.execute("isolated", request.arguments, undefined, undefined, undefined as any);
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
