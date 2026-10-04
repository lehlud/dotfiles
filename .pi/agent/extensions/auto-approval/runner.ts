// Runs inside the mandatory Docker or bwrap sandbox. No host fallback.
import {
  createBashToolDefinition, createPowerShellToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, createEditToolDefinition, createGrepToolDefinition,
  createFindToolDefinition, createLsToolDefinition, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { mkdir } from "node:fs/promises";

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
  if (!Object.hasOwn(factories, request.tool)) throw new Error("Unknown executor operation");
  await mkdir("/tmp/home", { recursive: true });
  const name = request.tool as keyof typeof factories;
  const tool = (name === "bash" ? createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }) : factories[name](process.cwd())) as ToolDefinition<any, any>;
  if (!Check(tool.parameters, request.arguments)) throw new Error("Invalid executor arguments");
  const result = await tool.execute("isolated", request.arguments, undefined, undefined, undefined as any);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
