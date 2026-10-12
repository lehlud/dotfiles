import type { Config } from "../../shared/configuration/schemas.ts";
import type { LocalTool } from "../local-tools.ts";
import type { WebRuntime } from "../../web-research/runtime.ts";

export type SandboxConfig = Config["sandbox"];

export type Workspace = {
  path: string;
  cwd: string;
  bindings: string[];
  readOnlyBindings?: string[];
  searchPaths?: string[];
  localTools?: LocalTool[];
  webRuntime?: WebRuntime;
  credentialExecutable?: string;
  gitSnapshots?: { source: string; target: string }[];
  temporaryDirectory?: string;
  masked: { path: string; directory: boolean }[];
};
