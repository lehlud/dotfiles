import { getuid, getgid } from "node:process";
import type { SandboxRequest } from "../../shared/contracts/action.ts";
import type { SandboxConfig, Workspace } from "./types.ts";
import { localToolArguments, webRuntimeArguments } from "./mount-arguments.ts";

export function dockerArguments(
  workspace: Workspace,
  config: Exclude<SandboxConfig, { backend: "bwrap" }>,
  name: string,
  request: SandboxRequest | undefined,
  environment: Record<string, string>,
) {
  const limits = request?.limits;
  const uid = getuid?.() ?? 501;
  const gid = getgid?.() ?? 20;
  const runtimeTmpfs = `rw,nosuid,nodev,size=268435456,mode=0700,uid=${uid},gid=${gid}`;

  return [
    "run",
    "--rm",
    "--interactive",
    "--name",
    name,
    "--pull",
    "never",
    "--network",
    request?.network ?? "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ipc",
    "none",
    "--cgroupns",
    "private",
    "--pids-limit",
    String(limits?.pids ?? 128),
    "--memory",
    `${limits?.memoryMiB ?? 1024}m`,
    "--cpus",
    String(limits?.cpus ?? 2),
    "--user",
    `${uid}:${gid}`,
    ...(workspace.temporaryDirectory
      ? [
          "--mount",
          `type=bind,src=${workspace.temporaryDirectory},dst=/tmp,bind-recursive=disabled`,
          "--tmpfs",
          `/tmp/home:${runtimeTmpfs}`,
          "--tmpfs",
          `/tmp/pi:${runtimeTmpfs}`,
        ]
      : ["--tmpfs", `/tmp:rw,nosuid,nodev,size=${limits?.tmpBytes ?? 268435456},mode=1777`]),
    ...(!workspace.bindings.length
      ? ["--tmpfs", `${workspace.path}:ro,nosuid,nodev,noexec,size=16777216`]
      : []),
    "--env",
    "HOME=/tmp/home",
    "--env",
    "PI_CODING_AGENT_DIR=/tmp/pi",
    ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...workspace.bindings.flatMap((path) => [
      "--mount",
      `type=bind,src=${path},dst=${path},bind-recursive=disabled${workspace.readOnlyBindings?.includes(path) ? ",readonly" : ""}`,
    ]),
    ...localToolArguments(workspace, false),
    ...webRuntimeArguments(workspace, false),
    "--workdir",
    workspace.cwd,
    "--entrypoint",
    workspace.localTools?.length ? "/bin/bash" : "/usr/local/bin/bun",
    config.image,
    ...(workspace.localTools?.length
      ? [
          "/opt/pi-tools/runtime/bootstrap.sh",
          ...workspace.localTools.map((tool) => tool.name),
          "--",
          "/usr/local/bin/bun",
        ]
      : []),
    "/executor/runner.ts",
  ];
}

