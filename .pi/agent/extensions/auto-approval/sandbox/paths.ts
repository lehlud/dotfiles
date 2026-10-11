import { relative, isAbsolute } from "node:path";
import type { SandboxConfig } from "./types.ts";

export const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};
export const backendPaths = (config: SandboxConfig) =>
  config.backend === "bwrap"
    ? [config.executable, config.runnerExecutable]
    : [config.dockerExecutable];
