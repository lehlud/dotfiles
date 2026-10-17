import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { within } from "./paths.ts";
import type { SandboxConfig, Workspace } from "./types.ts";

/** A mount is writable only when all inode aliases stay inside the reviewed boundary. */
export async function assertWorkspaceBoundary(
  workspace: Workspace,
  protectedRoots: string[],
  config: SandboxConfig,
  writable: (path: string) => boolean,
) {
  const { masked, bindings, temporaryDirectory } = workspace;
  const hidden = (path: string) => masked.some((entry) => within(entry.path, path));
  // Rust/Cargo and other build tools use hardlinks between output and deps.
  // The inode is writable only when every directory entry is exposed here.
  const hardlinks = new Map<
    string,
    { path: string; expected: number; seen: number; write: boolean; read: boolean }
  >();
  const walk = async (path: string): Promise<void> => {
    if (hidden(path)) return;

    const stat = await lstat(path);

    if (stat.isSymbolicLink()) {
      // Private /tmp links resolve in the isolated namespace, never host /tmp.
      const targetPath = resolve(dirname(path), await readlink(path));

      if (
        temporaryDirectory &&
        (within(temporaryDirectory, path) ||
          (within("/tmp", targetPath) && !bindings.some((binding) => within(binding, targetPath))))
      )
        return;

      // Build caches commonly leave dangling links. They expose no target;
      // the isolated filesystem also cannot resolve missing host paths.
      const target = await realpath(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;

        throw error;
      });

      if (!target) return;

      // Native bwrap already exposes /usr read-only. Virtualenv links to its
      // system Python need no additional host access or writable mount.
      const systemRuntime = config.backend === "bwrap" && within("/usr", target);

      if (
        hidden(target) ||
        protectedRoots.some((root) => within(root, target)) ||
        (!systemRuntime && !bindings.some((binding) => within(binding, target)))
      )
        throw new Error(`Workspace symlink escapes its exposed boundary: ${path}`);
    } else if (stat.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name));
    } else if (!stat.isFile()) throw new Error(`Workspace contains a special file: ${path}`);
    else if (stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      const entry = hardlinks.get(key);

      if (entry) {
        if (entry.expected !== stat.nlink)
          throw new Error(`Workspace hardlink changed during validation: ${path}`);

        entry.seen++;
        entry.write ||= writable(path);
        entry.read ||= !writable(path);
      } else
        hardlinks.set(key, {
          path,
          expected: stat.nlink,
          seen: 1,
          write: writable(path),
          read: !writable(path),
        });
    }
  };

  // Nested mounts must not cause the same inode entry to be counted twice.
  for (const path of [
    ...bindings.filter(
      (path, index) => !bindings.slice(0, index).some((parent) => within(parent, path)),
    ),
    ...(temporaryDirectory ? [temporaryDirectory] : []),
  ])
    await walk(path);

  for (const entry of hardlinks.values()) {
    if (entry.seen !== entry.expected)
      throw new Error(`Workspace hardlink has aliases outside its exposed boundary: ${entry.path}`);

    if (entry.write && entry.read)
      throw new Error(`Writable hardlink would modify a read-only grant: ${entry.path}`);
  }
}
