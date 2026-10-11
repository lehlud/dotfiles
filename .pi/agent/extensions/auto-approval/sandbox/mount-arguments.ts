import { toolRuntimeDirectory } from "../local-tools.ts";
import type { Workspace } from "./types.ts";

export function localToolArguments(workspace: Workspace, native: boolean): string[] {
  const tools = workspace.localTools ?? [];
  if (!tools.length) return [];
  const sources = [
    { source: toolRuntimeDirectory, target: "/opt/pi-tools/runtime" },
    ...tools.flatMap((tool) => tool.sources),
  ];
  for (const tool of tools) {
    if (tool.helper)
      sources.push({ source: tool.helper, target: `/opt/pi-tools/source/${tool.name}/helper` });
  }
  return sources.flatMap(({ source, target }) =>
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
