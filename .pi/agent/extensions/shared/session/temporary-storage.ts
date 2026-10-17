import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Remove only session-owned storage; never traverse a symbolic link. */
export async function removeSessionTemporaryDirectory(directory: string): Promise<void> {
  const makeRemovable = async (path: string): Promise<void> => {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;

      throw error;
    });

    if (!stat?.isDirectory()) return;

    // Build tools may leave directories read-only or inaccessible to their owner.
    await chmod(path, 0o700);

    for (const name of await readdir(path)) await makeRemovable(join(path, name));
  };

  await makeRemovable(directory);
  await rm(directory, { recursive: true, force: true });
}
