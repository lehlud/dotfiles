import { toolRuntimeDirectory } from "../local-tools.ts";
import type { Workspace } from "./types.ts";

/** Launchers stay at their real read-only paths; PATH proxies never copy their code. */
export function localToolBootstrapArguments(workspace: Workspace): string[] {
  return (workspace.localTools ?? []).flatMap((tool) => {
    // Node supplies native runtime executables, not a ~/.local/bin launcher.
    if (tool.name === "node") return [tool.name];

    if (!tool.commandDirectory) throw new Error(`Missing local launcher directory: ${tool.name}`);

    return [tool.name, tool.commandDirectory, tool.helper ?? ""];
  });

}

export function localToolArguments(workspace: Workspace, native: boolean): string[] {
  const tools = workspace.localTools ?? [];

  if (!tools.length) return [];

  const sources = [
    { source: toolRuntimeDirectory, target: "/opt/pi-tools/runtime" },
    ...tools.flatMap((tool) => tool.sources),
  ];

  for (const tool of tools) {
    if (tool.helper) sources.push({ source: tool.helper, target: tool.helper });

  }

  const targets = new Map<string, { source: string; target: string }>();

  for (const mount of sources) {
    const previous = targets.get(mount.target);

    if (previous && previous.source !== mount.source)
      throw new Error(`Conflicting local tool mount: ${mount.target}`);

    // Original paths already declared as read-only grants need no second bind.
    // Shared public helpers likewise occupy only one Docker mount destination.
    if (mount.source === mount.target && workspace.readOnlyBindings?.includes(mount.source))
      continue;

    targets.set(mount.target, mount);
  }

  return [...targets.values()].flatMap(({ source, target }) =>
    native
      ? ["--ro-bind", source, target]
      : ["--mount", `type=bind,src=${source},dst=${target},bind-recursive=disabled,readonly`],
  );
}

export function webRuntimeArguments(workspace: Workspace, native: boolean): string[] {
  if (!workspace.webRuntime) return [];

  const { dependencies, worker } = workspace.webRuntime;

  return [
    { source: dependencies, target: "/opt/pi-web/dependencies" },
    { source: worker, target: "/opt/pi-web/worker.py" },
  ].flatMap(({ source, target }) =>
    native
      ? ["--ro-bind", source, target]
      : ["--mount", `type=bind,src=${source},dst=${target},bind-recursive=disabled,readonly`],
  );
}

