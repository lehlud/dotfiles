import { access, mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxRequest } from "../../shared/contracts/action.ts";
import type { SandboxConfig, Workspace } from "./types.ts";
import { planCgroup } from "./cgroup-plan.ts";

/** Fixed clean-environment launcher: attach before executing any sandbox payload. */
const ATTACH = 'set -eu; group=$1; shift; printf "%s\\n" "$$" > "$group/cgroup.procs"; exec "$@"';

async function writeVerified(path: string, file: string, value: string) {
  await writeFile(join(path, file), value);

  if ((await readFile(join(path, file), "utf8")).trim() !== value)
    throw new Error(`Kernel did not apply cgroup control ${file}`);
}

/** Only freshly created action children are written or killed; the parent remains untouched. */
export async function createCgroupScope(
  config: SandboxConfig,
  workspace: Workspace,
  request?: SandboxRequest,
) {
  const plan = await planCgroup(config, request?.limits);

  if (!plan) return undefined;

  if (!isDeepStrictEqual(plan, workspace.cgroup))
    throw new Error("Cgroup delegation or resource limits changed after independent review");

  const path = join(plan.root, `pi-action-${randomUUID()}`);

  await mkdir(path, { mode: 0o700 });

  try {
    for (const [file, value] of Object.entries(plan.controls))
      await writeVerified(path, file, value);

    await access(join(path, "cgroup.kill"), constants.W_OK);

    return new ActionCgroup(path, await stat(path));
  } catch (error) {
    await rmdir(path);

    throw error;
  }
}

class ActionCgroup {
  private killed?: Promise<void>;

  constructor(
    readonly path: string,
    private readonly identity: { dev: number; ino: number },
  ) {}

  launch(executable: string, args: string[]) {
    return {
      executable: "/bin/sh",
      args: ["-c", ATTACH, "pi-cgroup-attach", this.path, executable, ...args],
    };
  }

  private async assertIdentity() {
    const current = await stat(this.path);

    if (current.dev !== this.identity.dev || current.ino !== this.identity.ino)
      throw new Error("Action cgroup identity changed; refusing to touch a replacement");
  }

  kill(): Promise<void> {
    this.killed ??= this.assertIdentity().then(() =>
      writeFile(join(this.path, "cgroup.kill"), "1"),
    );

    return this.killed;
  }

  async memoryKilled(): Promise<boolean> {
    const events = await readFile(join(this.path, "memory.events"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";

        throw error;
      },
    );

    return /^oom_kill [1-9]/mu.test(events);
  }

  async dispose() {
    await this.kill();

    for (let attempt = 0; attempt < 200; attempt++) {
      if (/^populated 0$/mu.test(await readFile(join(this.path, "cgroup.events"), "utf8"))) {
        await this.assertIdentity();
        await rmdir(this.path);

        return;
      }

      await delay(10);
    }

    throw new Error("Action cgroup did not drain after cancellation; no unrestricted fallback");
  }
}

export type CgroupScope = Awaited<ReturnType<typeof createCgroupScope>>;
