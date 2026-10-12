import { lstat, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { resolve, join, relative, dirname } from "node:path";
import { within } from "./paths.ts";
import type { Workspace } from "./types.ts";

export function sandboxHostPath(workspace: Workspace, path: string): string {
  const absolute = resolve(workspace.cwd, path);

  if (
    !workspace.temporaryDirectory ||
    !within("/tmp", absolute) ||
    workspace.bindings.some((binding) => within(binding, absolute))
  )
    return absolute;

  return join(workspace.temporaryDirectory, relative("/tmp", absolute));
}

type TemporaryMountpoint = { path: string; dev: number; ino: number };

export async function temporaryMountpoints(workspace: Workspace): Promise<TemporaryMountpoint[]> {
  if (!workspace.temporaryDirectory) return [];

  const created: TemporaryMountpoint[] = [];

  for (const guest of [
    "/tmp/home",
    "/tmp/pi",
    ...workspace.bindings.filter((path) => within("/tmp", path)),
  ]) {
    const target = join(workspace.temporaryDirectory, relative("/tmp", guest));
    let path = target;

    if (await unsafeTemporaryParent(workspace.temporaryDirectory, path)) continue;

    const absent: string[] = [];

    while (path !== workspace.temporaryDirectory) {
      try {
        await lstat(path);

        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

      }

      absent.push(path);
      path = dirname(path);
    }

    const directory =
      guest === "/tmp/home" || guest === "/tmp/pi" || (await lstat(guest)).isDirectory();

    for (const path of absent.reverse()) {
      try {
        if (path !== target || directory) await mkdir(path, { mode: 0o700 });
        else await writeFile(path, "", { flag: "wx", mode: 0o600 });

      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;

        throw error;
      }

      const stat = await lstat(path);

      created.push({ path, dev: stat.dev, ino: stat.ino });
    }

  }

  return created.sort((a, b) => b.path.length - a.path.length);
}

async function unsafeTemporaryParent(root: string, path: string): Promise<boolean> {
  let current = root;

  for (const part of relative(root, dirname(path)).split("/").filter(Boolean)) {
    current = join(current, part);

    try {
      if (!(await lstat(current)).isDirectory()) return true;

    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;

      throw error;
    }

  }

  return false;
}

export async function cleanTemporaryMountpoints(
  root: string | undefined,
  paths: TemporaryMountpoint[],
): Promise<void> {
  if (!root) return;

  for (const entry of paths) {
    const path = entry.path;

    if (await unsafeTemporaryParent(root, path)) continue;

    try {
      const stat = await lstat(path);

      if (stat.dev !== entry.dev || stat.ino !== entry.ino) continue;

      if (stat.isDirectory()) await rmdir(path);
      else if (stat.isFile() && stat.size === 0 && stat.nlink === 1) await unlink(path);

    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;

    }

  }

}

