import { Check } from "typebox/value";
import { type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { actionSnapshot } from "../shared/contracts/action-snapshot.ts";
import { factories, strictParameters, type ToolName } from "./tool-catalog.ts";
import { normalizeNetworkFlag, type Request } from "../shared/contracts/action.ts";
import { checkActionSize } from "../shared/review/context.ts";
import { assertSandboxReady } from "../shared/configuration/load.ts";
import { loadSessionConfig } from "../shared/session/config.ts";
import { validateWorkspace, sandboxHostPath } from "./isolation.ts";
import { canonicalPath, type ProtectedPaths } from "./protected-paths.ts";
import type { ActionSession } from "./action-session.ts";
import { validateGitRequest } from "./git-config.ts";
import { credentialProtectedPaths, resolveCredentialPlan } from "./credential-access.ts";
import { isWebTool } from "../web-research/index.ts";
import { resolveWebRuntime, reviewedWebRequest } from "../web-research/runtime.ts";
import { describeSandbox } from "./sandbox-plan.ts";
import { sessionServices } from "../shared/session/services.ts";
import { remoteSession } from "../shared/session/remote.ts";
import { REMOTE_TOOLS, type RemotePrepared } from "../shared/contracts/remote.ts";
import type { Workspace } from "./isolation.ts";
import { assertDelegatedAction } from "../shared/contracts/subagents.ts";

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

  assertDelegatedAction(sessionServices(ctx).delegationMode, request);

  checkActionSize(request);
  stage("sandbox configuration");

  const config = await loadSessionConfig(ctx);

  await assertSandboxReady(config);

  const name = request.tool as ToolName;
  // Private built-in definitions: never resolve a same-name extension/MCP
  // override, never expose ctx.executeTool(), and never use commandPrefix.
  const tool = factories[name](ctx.cwd) as ToolDefinition<any, any>;

  if (!Check(tool.parameters, request.arguments))
    throw new Error("Invalid underlying tool arguments");

  const remoteRoute = remoteSession(ctx);
  const remoteTarget = remoteRoute?.target();

  validateGitRequest(request, config, Boolean(remoteTarget));

  const remoteTool = REMOTE_TOOLS.has(name);

  if (name === "remote_tunnel" && !remoteTarget)
    throw new Error("Select a remote workspace with /remote first");

  if (remoteTarget && remoteTool) {
    stage("remote workspace validation");

    const remote: RemotePrepared = remoteRoute!.prepare(
      request,
      config,
      ctx.sessionManager.getSessionId(),
      sessionServices(ctx).delegationMode === "review",
    );
    const workspace: Workspace = {
      path: remoteTarget.root,
      cwd: remoteTarget.root,
      bindings: [remoteTarget.root],
      masked: [],
    };
    const localGitWorkspace = request.sandbox?.gitConfig
      ? await validateWorkspace(
          ctx.cwd,
          config.sandbox,
          protection.paths,
          undefined,
          undefined,
          "credential",
        )
      : undefined;

    return {
      request,
      config,
      workspace,
      credentialPlan: undefined,
      sandboxPlan: remote.plan,
      remote,
      localGitWorkspace,
    };
  }

  if (
    remoteTarget &&
    name === "credential_exec" &&
    (request.sandbox?.projectFiles || request.sandbox?.paths)
  )
    throw new Error(
      "Credential tools execute locally; remote project files cannot be exposed through local mount grants",
    );

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

  if (sessionServices(ctx).delegationMode === "review")
    workspace.readOnlyBindings = [
      ...new Set([...(workspace.readOnlyBindings ?? []), ...workspace.bindings]),
    ];

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

  return {
    request,
    config,
    workspace,
    credentialPlan,
    sandboxPlan,
    remote: undefined as RemotePrepared | undefined,
    localGitWorkspace: undefined as Workspace | undefined,
  };
}

export type PreparedAction = Awaited<ReturnType<typeof prepareAction>>;
