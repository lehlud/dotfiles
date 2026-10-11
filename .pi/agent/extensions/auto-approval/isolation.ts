// Stable sandbox facade for callers and test doubles; implementations have separate ownership.
export type { SandboxConfig, Workspace } from "./sandbox/types.ts";
export { detectWorkspace, validateWorkspace } from "./sandbox/workspace.ts";
export { sandboxHostPath } from "./sandbox/temporary-mounts.ts";
export { sandboxArguments } from "./sandbox/arguments.ts";
export { executeIsolated } from "./sandbox/execute.ts";
