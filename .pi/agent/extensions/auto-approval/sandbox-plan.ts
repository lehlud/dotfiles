import type { Request } from "../shared/contracts/action.ts";
import type { Config } from "../shared/configuration/schemas.ts";
import type { Workspace } from "./isolation.ts";
import { credentialReviewPlan, type CredentialPlan } from "./credential-access.ts";
import { isWebTool } from "../web-research/index.ts";
import { webExecutionPlan } from "../web-research/execute.ts";

/** Public review metadata only; resolving actual credentials remains a post-approval operation. */
export function describeSandbox(
  request: Request,
  workspace: Workspace,
  config: Config,
  credentialPlan?: CredentialPlan,
) {
  const name = request.tool;
  const credential = name === "credential_exec";
  return {
    workspace: workspace.path,
    bindings: workspace.bindings,
    readOnlyBindings: workspace.readOnlyBindings ?? [],
    executableSearchPaths: workspace.searchPaths ?? [],
    localTools: workspace.localTools ?? [],
    gitConfiguration:
      request.sandbox?.gitConfig === true
        ? {
            scope: "supported public global Git settings and author identity",
            readOnly: true,
            lifetime: "one Git command",
            originalsMounted: false,
            credentials: false,
          }
        : undefined,
    credentials: credentialPlan
      ? credentialReviewPlan(credentialPlan, workspace.bindings.length > 0)
      : undefined,
    webRuntime: isWebTool(name)
      ? {
          ...(workspace.webRuntime ?? { imageBundled: true }),
          readOnly: true,
          execution: webExecutionPlan(request),
        }
      : undefined,
    localToolStorage: workspace.localTools?.length
      ? { path: "/tmp/pi-tools", lifetime: "Pi session", updates: "private copies only" }
      : undefined,
    temporaryStorage: {
      path: "/tmp",
      lifetime: credential || name === "git" ? "one action" : "Pi session",
      private: true,
    },
    requested: request.sandbox ?? {},
    backend: config.sandbox.backend ?? "docker",
  };
}
