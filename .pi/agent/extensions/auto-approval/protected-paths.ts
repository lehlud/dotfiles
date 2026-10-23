import { realpath } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const sourceDir = dirname(fileURLToPath(import.meta.url));

// Resolve symlinks even for not-yet-created paths. Unexpected filesystem errors
// fail closed rather than letting a textual path check authorize an alias.
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    const parent = dirname(path);

    if (parent === path) throw error;

    return join(await canonicalPath(parent), basename(path));
  }
}

export class ProtectedPaths {
  readonly paths = [
    sourceDir,
    // Shared gate contracts stay protected even with a custom PI_CODING_AGENT_DIR.
    join(sourceDir, "../shared"),
    join(sourceDir, "../remote"),
    getAgentDir(),
    join(homedir(), ".docker"),
    join(homedir(), ".ssh"),
    join(homedir(), ".aws"),
    join(homedir(), ".gnupg"),
    join(homedir(), ".codex"),
    join(homedir(), ".claude"),
    join(homedir(), ".config", "gh"),
    join(homedir(), ".local", "cache", "pi"),
    join(homedir(), ".local", "cache", "pi-web-research"),
    join(homedir(), ".local", "bin", "pi"),
    join(homedir(), ".local", "bin", "auto-update-app.bash"),
    process.execPath,
  ];
  readonly roots = Promise.all(this.paths.map(canonicalPath));
  // Catch now to avoid an unhandled rejection; awaiting below still fails closed.
  constructor() {
    void this.roots.catch(() => {});
  }
}
