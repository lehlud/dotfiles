import { Check } from "typebox/value";
import {
  getAgentDir,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { actionSnapshot } from "../shared/contracts/action-snapshot.ts";
import { factories, strictParameters, type ToolName } from "./tool-catalog.ts";
import { normalizeNetworkFlag, type Request } from "../shared/contracts/action.ts";
import { checkActionSize } from "../shared/review/context.ts";
import { loadConfig, assertSandboxReady } from "../shared/configuration/load.ts";
import { validateWorkspace, sandboxHostPath } from "./isolation.ts";
import { canonicalPath, type ProtectedPaths } from "./protected-paths.ts";
import type { ActionSession } from "./action-session.ts";
import { validateGitRequest } from "./git-config.ts";
import { credentialProtectedPaths, resolveCredentialPlan } from "./credential-access.ts";
import { isWebTool } from "../web-research/index.ts";
import { resolveWebRuntime, reviewedWebRequest } from "../web-research/runtime.ts";
import { describeSandbox } from "./sandbox-plan.ts";

export async function prepareAction(
  raw: unknown,
  ctx: ExtensionContext,
  session: ActionSession,
  protection: ProtectedPaths,
  stage: (name: string) => void,
) {
  const snapshot = actionSnapshot(raw) as Request;
  const validRequest: boolean = Check(strictParameters, snapshot);
  if (!validRequest || !snapshot.goal.trim() || !snapshot.justification.trim())
    throw new Error("Invalid action, goal, or justification");
  const request = reviewedWebRequest(normalizeNetworkFlag(snapshot));
  checkActionSize(request);
  stage("sandbox configuration");
  const config = await loadConfig(getAgentDir());
  await assertSandboxReady(config);
  const name = request.tool as ToolName;
  // Private built-in definitions: never resolve a same-name extension/MCP
  // override, never expose ctx.executeTool(), and never use commandPrefix.
  const tool = factories[name](ctx.cwd) as ToolDefinition<any, any>;
  if (!Check(tool.parameters, request.arguments))
    throw new Error("Invalid underlying tool arguments");
  validateGitRequest(request, config);
  const credential = name === "credential_exec";
  if (!credential && request.sandbox?.projectFiles !== undefined)
    throw new Error("projectFiles is available only to credential_exec");
  stage("credential profile validation");
  const credentialPlan = credential ? await resolveCredentialPlan(request, config) : undefined;
  const activeProtectedPaths = [...protection.paths, ...credentialProtectedPaths(config)];
  const privateTmp = credential || name === "git" ? undefined : await session.temporaryStorage();
  stage("workspace validation");
  const mode = isWebTool(name)
    ? "web"
    : credential && !request.sandbox?.projectFiles
      ? "credential"
      : "project";
  const workspace = await validateWorkspace(
    ctx.cwd,
    config.sandbox,
    activeProtectedPaths,
    request.sandbox,
    privateTmp,
    mode,
  );
  if (isWebTool(name) && config.sandbox.backend === "bwrap") {
    stage("web runtime preparation");
    workspace.webRuntime = await resolveWebRuntime();
  }
  if (name === "write" || name === "edit") {
    stage("protected path validation");
    const path = await canonicalPath(sandboxHostPath(workspace, String(request.arguments.path)));
    const roots = [
      ...(await protection.roots),
      ...(await Promise.all(credentialProtectedPaths(config).map(canonicalPath))),
    ];
    if (roots.some((p) => path === p || path.startsWith(`${p}/`)))
      throw new Error(
        "The agent cannot modify Pi installation, approval code, configuration, or credentials",
      );
  }
  const sandboxPlan = describeSandbox(request, workspace, config, credentialPlan);
  return { request, config, workspace, credentialPlan, sandboxPlan };
}
export type PreparedAction = Awaited<ReturnType<typeof prepareAction>>;
