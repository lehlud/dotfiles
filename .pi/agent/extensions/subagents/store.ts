import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export class Checkpoints {
  private root: string;
  private directory: string;
  private writes = new Map<string, Promise<void>>();
  constructor(ctx: ExtensionContext) {
    const parent = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex");

    this.root = join(getAgentDir(), "subagents");
    this.directory = join(this.root, parent);
  }

  private path(id: string) {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("Invalid subagent ID");

    return join(this.directory, `${id}.json`);
  }

  save(id: string, manager: SessionManager) {
    const text = JSON.stringify([manager.getHeader(), ...manager.getBranch()]);

    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw new Error("Subagent checkpoint exceeds 16 MiB");

    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.write(id, text));

    this.writes.set(id, next);

    return next.finally(() => {
      if (this.writes.get(id) === next) this.writes.delete(id);
    });
  }

  private async write(id: string, text: string) {
    await mkdir(this.root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });

    const rootInfo = await lstat(this.root);

    if (
      !rootInfo.isDirectory() ||
      rootInfo.uid !== process.getuid?.() ||
      (rootInfo.mode & 0o077) !== 0
    )
      throw new Error("Unsafe subagent storage root");

    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    const info = await lstat(this.directory);

    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("Subagent checkpoint directory must be private and owned by this user");

    const path = this.path(id),
      temporary = `${path}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async load(id: string, cwd: string) {
    await this.writes.get(id);

    for (const directory of [this.root, this.directory]) {
      const info = await lstat(directory);

      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new Error("Unsafe subagent checkpoint directory");
    }

    const path = this.path(id),
      info = await lstat(path);

    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 16 * 1024 * 1024
    )
      throw new Error("Unsafe subagent checkpoint");

    const entries = JSON.parse(await readFile(path, "utf8"));

    if (!Array.isArray(entries) || entries[0]?.type !== "session" || entries[0].cwd !== cwd)
      throw new Error("Invalid subagent checkpoint");

    return SessionManager.inMemory(cwd, undefined, entries);
  }
}
