import type { SandboxRequest } from "../../shared/contracts/action.ts";
import type { SandboxConfig, Workspace } from "./types.ts";
import { bwrapArguments } from "./bwrap.ts";
import { dockerArguments } from "./docker.ts";

export function sandboxArguments(
  workspace: Workspace,
  config: SandboxConfig,
  name: string,
  request?: SandboxRequest,
) {
  const limits = request?.limits;

  if (workspace.temporaryDirectory && limits?.tmpBytes !== undefined)
    throw new Error(
      "tmpBytes cannot limit a persistent disk-backed /tmp; omit it for session temporary storage",
    );

  const environment = {
    ...(workspace.searchPaths?.length
      ? { PATH: [...workspace.searchPaths, "/usr/bin", "/bin"].join(":") }
      : {}),
    ...request?.environment,
  };

  if (
    Object.keys(environment).some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
    Object.values(environment).some((value) => value.includes("\0"))
  )
    throw new Error("Invalid sandbox environment");

  return config.backend === "bwrap"
    ? bwrapArguments(workspace, config, request, environment)
    : dockerArguments(workspace, config, name, request, environment);
}

