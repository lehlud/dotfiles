import type { SandboxRequest } from "../../shared/contracts/action.ts";
import type { SandboxConfig, Workspace } from "./types.ts";
import {
  localToolArguments,
  localToolBootstrapArguments,
  webRuntimeArguments,
} from "./mount-arguments.ts";

export function bwrapArguments(
  workspace: Workspace,
  config: Extract<SandboxConfig, { backend: "bwrap" }>,
  request: SandboxRequest | undefined,
  environment: Record<string, string>,
) {
  const limits = request?.limits;
  const args = [
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind-try",
    "/etc/alternatives",
    "/etc/alternatives",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...(workspace.temporaryDirectory
      ? [
          "--bind",
          workspace.temporaryDirectory,
          "/tmp",
          "--size",
          "268435456",
          "--tmpfs",
          "/tmp/home",
          "--size",
          "268435456",
          "--tmpfs",
          "/tmp/pi",
        ]
      : ["--size", String(limits?.tmpBytes ?? 268435456), "--tmpfs", "/tmp", "--dir", "/tmp/home"]),
    "--ro-bind",
    config.runnerExecutable,
    "/executor/runner",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp/home",
    "--setenv",
    "PI_CODING_AGENT_DIR",
    "/tmp/pi",
    "--setenv",
    "LANG",
    "C.UTF-8",
  ];

  if (request?.network === "host") args.push("--share-net");

  if (request?.network === "host") {
    for (const path of [
      "/etc/resolv.conf",
      "/etc/hosts",
      "/etc/nsswitch.conf",
      "/etc/ssl/cert.pem",
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/pki/tls/certs/ca-bundle.crt",
      "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    ])
      args.push("--ro-bind-try", path, path);
  }

  for (const [key, value] of Object.entries(environment)) args.push("--setenv", key, value);

  if (!workspace.bindings.includes(workspace.path))
    args.push("--size", "16777216", "--tmpfs", workspace.path);

  for (const path of workspace.bindings)
    args.push(workspace.readOnlyBindings?.includes(path) ? "--ro-bind" : "--bind", path, path);

  for (const entry of workspace.masked) {
    if (entry.directory)
      args.push("--perms", "000", "--tmpfs", entry.path, "--remount-ro", entry.path);
    else args.push("--ro-bind", "/dev/null", entry.path);
  }

  args.push(...localToolArguments(workspace, true));
  args.push(...webRuntimeArguments(workspace, true));

  if (workspace.localTools?.some((tool) => tool.name === "flutter")) {
    for (const path of ["/run/.containerenv", "/.dockerenv"])
      args.push("--ro-bind-try", path, path);
  }

  if (workspace.credentialExecutable)
    args.push("--ro-bind", workspace.credentialExecutable, "/opt/pi-credential/tool");

  for (const { source, target } of workspace.gitSnapshots ?? [])
    args.push("--ro-bind", source, target);

  // Projected parent directories are ephemeral and read-only. Only mounts persist.
  if (!workspace.bindings.includes(workspace.path)) args.push("--remount-ro", workspace.path);

  args.push(
    "--chdir",
    workspace.cwd,
    ...(workspace.localTools?.length
      ? [
          "/bin/bash",
          "/opt/pi-tools/runtime/bootstrap.sh",
          ...localToolBootstrapArguments(workspace),
          "--",
        ]
      : []),
    "/executor/runner",
  );

  return args;
}
