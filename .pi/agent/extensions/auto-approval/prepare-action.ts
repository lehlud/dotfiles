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
import { maintenancePaths } from "./maintenance.ts";
import { scopeHomeFile } from "./sandbox/home-access.ts";
import { containerFileReader } from "./container-reader.ts";
import type { ContainerPrepared } from "../shared/contracts/containers.ts";
import { assertDelegatedAction } from "../shared/contracts/subagents.ts";

export async function prepareAction(
  raw: unknown,
  ctx: ExtensionContext,
  session: ActionSession,
  protection: ProtectedPaths,
  stage: (name: string) => void,
  signal?: AbortSignal,
) {
  const snapshot = actionSnapshot(raw) as Request;
  const validRequest: boolean = Check(strictParameters, snapshot);

  if (!validRequest || !snapshot.goal.trim() || !snapshot.justification.trim())
    throw new Error("Invalid action, goal, or justification");

  let request = reviewedWebRequest(normalizeNetworkFlag(snapshot));

  assertDelegatedAction(sessionServices(ctx).delegationMode, request);

  if (request.background) {
    if (!request.background.title.trim() || !request.background.work.trim())
      throw new Error("Background jobs need a title and independent work description");

    if (!sessionServices(ctx).jobs)
      throw new Error("Background supervisor unavailable; restart Pi through ~/.local/bin/pi");

    const output = request.sandbox?.limits?.maxOutputBytes ?? 65536;

    if (output > 131072)
      throw new Error(
        "Background retained output is limited to 131072 bytes; redirect full logs to reviewed project artifacts",
      );

    request = {
      ...request,
      sandbox: {
        ...request.sandbox,
        limits: { ...request.sandbox?.limits, maxOutputBytes: output },
      },
    };
  }

  checkActionSize(request);
  stage("sandbox configuration");

  const config = await loadSessionConfig(ctx);

  await assertSandboxReady(config);

  let reviewedProtection = [...protection.paths];

  const name = request.tool as ToolName;
  // Private built-in definitions: never resolve a same-name extension/MCP
  // override, never expose ctx.executeTool(), and never use commandPrefix.
  const tool = factories[name](ctx.cwd) as ToolDefinition<any, any>;

  if (!Check(tool.parameters, request.arguments))
    throw new Error("Invalid underlying tool arguments");

  const remoteRoute = remoteSession(ctx);
  const remoteTarget = remoteRoute?.target();

  if (remoteTarget && request.sandbox?.maintenance)
    throw new Error("Pi maintenance runs locally; turn off /remote before editing this Pi setup");

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
      reviewedProtection,
      workspace,
      credentialPlan: undefined,
      sandboxPlan: remote.plan,
      remote,
      container: undefined as ContainerPrepared | undefined,
      localGitWorkspace,
    };
  }

  request = await scopeHomeFile(request, ctx.cwd);
  reviewedProtection = await maintenancePaths(request, protection.paths);

  if (
    remoteTarget &&
    ["credential_exec", "container_exec"].includes(name) &&
    (request.sandbox?.projectFiles || request.sandbox?.paths)
  )
    throw new Error(
      "Credential/container tools execute locally; remote project files cannot be exposed through local mount grants",
    );

  const credential = name === "credential_exec";
  const containerJob = name === "container_exec";

  if (!credential && !containerJob && request.sandbox?.projectFiles !== undefined)
    throw new Error("projectFiles is available only to credential_exec/container_exec");

  stage("credential profile validation");

  const credentialPlan = credential ? await resolveCredentialPlan(request, config) : undefined;
  const activeProtectedPaths = [...reviewedProtection, ...credentialProtectedPaths(config)];
  const privateTmp =
    credential || containerJob || name === "git" ? undefined : await session.temporaryStorage();

  stage("workspace validation");

  const mode = request.sandbox?.maintenance
    ? "scoped"
    : isWebTool(name)
      ? "web"
      : (credential || containerJob) && !request.sandbox?.projectFiles
        ? "credential"
        : "project";
  const workspace = await validateWorkspace(
    ctx.cwd,
    config.sandbox,
    activeProtectedPaths,
    containerJob ? { ...request.sandbox, limits: undefined } : request.sandbox,
    privateTmp,
    mode,
  );

  if (containerJob) {
    if (config.sandbox.backend !== "bwrap")
      throw new Error("Container jobs currently require the native Linux Lubox transport");

    const route = sessionServices(ctx).containers;

    if (!route)
      throw new Error("Container tools are unavailable; restart Pi through ~/.local/bin/pi");

    if (mode === "credential") {
      workspace.path = ctx.cwd;
      workspace.cwd = ctx.cwd;
    }

    stage("container job preparation");

    const container = await route.prepare(
      request,
      workspace,
      containerFileReader(workspace, config, signal),
    );

    return {
      request,
      config,
      reviewedProtection,
      workspace,
      credentialPlan: undefined,
      sandboxPlan: container.plan,
      remote: undefined as RemotePrepared | undefined,
      container,
      localGitWorkspace: undefined as Workspace | undefined,
    };
  }

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
      ...(await Promise.all(reviewedProtection.map(canonicalPath))),
      ...(await Promise.all(credentialProtectedPaths(config).map(canonicalPath))),
    ];

    if (roots.some((p) => path === p || path.startsWith(`${p}/`)))
      throw new Error(
        "Protected path: use sandbox.maintenance with selected paths for an operator-requested Pi change; credentials and active executors remain excluded",
      );
  }

  const sandboxPlan = describeSandbox(request, workspace, config, credentialPlan);

  return {
    request,
    config,
    reviewedProtection,
    workspace,
    credentialPlan,
    sandboxPlan,
    remote: undefined as RemotePrepared | undefined,
    container: undefined as ContainerPrepared | undefined,
    localGitWorkspace: undefined as Workspace | undefined,
  };
}

export type PreparedAction = Awaited<ReturnType<typeof prepareAction>>;
