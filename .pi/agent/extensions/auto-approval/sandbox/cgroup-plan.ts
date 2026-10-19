import { access, readFile, realpath, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { SandboxRequest } from "../../shared/contracts/action.ts";
import type { SandboxConfig } from "./types.ts";

export type CgroupPlan = {
  root: string;
  device: number;
  inode: number;
  controls: Record<string, string>;
};

export function cgroupControls(limits: SandboxRequest["limits"]): Record<string, string> {
  const controls: Record<string, string> = {};

  if (limits?.memoryMiB !== undefined) {
    if (!Number.isInteger(limits.memoryMiB) || limits.memoryMiB < 64 || limits.memoryMiB > 65536)
      throw new Error("Invalid aggregate memory limit");

    controls["memory.max"] = String(limits.memoryMiB * 1024 * 1024);
    controls["memory.swap.max"] = "0";
    controls["memory.oom.group"] = "1";
  }

  if (limits?.cpus !== undefined) {
    if (!Number.isFinite(limits.cpus) || limits.cpus < 0.1 || limits.cpus > 64)
      throw new Error("Invalid aggregate CPU quota");

    controls["cpu.max"] = `${Math.ceil(limits.cpus * 100000)} 100000`;
  }

  if (limits?.pids !== undefined) {
    if (!Number.isInteger(limits.pids) || limits.pids < 16 || limits.pids > 65536)
      throw new Error("Invalid aggregate task limit");

    controls["pids.max"] = String(limits.pids);
  }

  return controls;
}

/** Inspect only: never move Pi, enable parent controllers or change container-wide limits. */
export async function planCgroup(
  config: SandboxConfig,
  limits: SandboxRequest["limits"],
): Promise<CgroupPlan | undefined> {
  const controls = cgroupControls(limits);

  if (config.backend !== "bwrap" || !Object.keys(controls).length) return undefined;

  if (!config.cgroupRoot)
    throw new Error(
      "Bwrap aggregate limits require a delegated cgroup v2 subtree: configure sandbox.cgroupRoot in auto-approval.device.json outside Pi. Required limits cannot be dropped.",
    );

  try {
    const root = await realpath(config.cgroupRoot);
    const info = await stat(root);

    if (
      process.platform !== "linux" ||
      (await statfs(root)).type !== 0x63677270 ||
      !info.isDirectory()
    )
      throw new Error("Configured root is not a cgroup v2 directory");

    if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
      throw new Error(
        "Delegated subtree must be owned by the Pi user and not writable by other users",
      );

    await access(root, constants.W_OK | constants.X_OK);

    if ((await readFile(join(root, "cgroup.procs"), "utf8")).trim())
      throw new Error("Delegated action subtree must contain no processes");

    if ((await readFile(join(root, "cgroup.type"), "utf8")).trim() !== "domain")
      throw new Error("Delegated action subtree must use domain cgroups");

    const enabled = new Set(
      (await readFile(join(root, "cgroup.subtree_control"), "utf8")).trim().split(/\s+/u),
    );

    for (const controller of new Set(Object.keys(controls).map((file) => file.split(".")[0]))) {
      if (!enabled.has(controller))
        throw new Error(`Controller ${controller} is not delegated and enabled`);
    }

    return { root, device: info.dev, inode: info.ino, controls };
  } catch (error) {
    throw new Error(
      `Bwrap cgroup delegation unavailable at ${config.cgroupRoot}; repair delegation outside Pi, not by removing required limits. ${String(error)}`,
      { cause: error },
    );
  }
}
