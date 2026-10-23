import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Request } from "../shared/contracts/action.ts";
import { canonicalPath } from "./protected-paths.ts";
import { within } from "./sandbox/paths.ts";

/** Maintenance exposes source/configuration only, never the enclosing private agent directory. */
export async function maintenancePaths(request: Request, ordinary: readonly string[]) {
  if (!request.sandbox?.maintenance) return [...ordinary];

  if (!["read", "ls", "find", "grep", "write", "edit", "bash", "powershell"].includes(request.tool))
    throw new Error(
      "Pi maintenance uses local file/shell tools; it cannot delegate credentials or engine access",
    );

  if (!request.sandbox.paths?.length || request.sandbox.projectFiles)
    throw new Error(
      "Pi maintenance requires selected sandbox.paths, not an implicit project mount",
    );

  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const agent = await canonicalPath(getAgentDir());
  const extensions = await canonicalPath(source);
  const launcher = await canonicalPath(join(homedir(), ".local/bin/pi"));
  const files = await Promise.all(
    [
      "auto-approval.json",
      "auto-approval.device.json",
      "auto-approval.local.json",
      "settings.json",
      "models.json",
    ].map((name) => canonicalPath(join(agent, name))),
  );
  const allowed = [extensions, await canonicalPath(join(agent, "extensions"))];
  const soft = [agent, extensions, launcher];

  for (const entry of request.sandbox.paths) {
    const path = await canonicalPath(entry.path);
    const overlaps = soft.some((root) => within(root, path) || within(path, root));

    if (
      overlaps &&
      !allowed.some((root) => within(root, path)) &&
      !files.includes(path) &&
      path !== launcher
    )
      throw new Error(
        "Maintenance grants must select Pi extension source, public configuration files or its launcher; private agent data remains excluded",
      );
  }

  const mutable = new Set(
    await Promise.all(
      [
        agent,
        launcher,
        ...["auto-approval", "shared", "remote", "container-tools"].map((name) =>
          join(extensions, name),
        ),
      ].map(canonicalPath),
    ),
  );
  const activeProcess = await canonicalPath(process.execPath);
  const retained = [];

  for (const path of ordinary) {
    const root = await canonicalPath(path);

    if (root !== activeProcess && mutable.has(root)) continue;

    retained.push(path);
  }

  return retained;
}
