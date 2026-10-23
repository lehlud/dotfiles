import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Request } from "../../shared/contracts/action.ts";
import { within } from "./paths.ts";

/** Named file tools need one reviewed file, never a writable mount of the whole home. */
export async function scopeHomeFile(
  request: Request,
  cwd: string,
  home = homedir(),
): Promise<Request> {
  if (!["read", "write", "edit"].includes(request.tool)) return request;

  if ((await realpath(cwd)) !== (await realpath(home))) return request;

  const supplied = String(request.arguments.path);
  let path = resolve(cwd, supplied === "~" ? home : supplied.replace(/^~\//, home + "/"));

  if (!within(home, path) || path === home) return request;

  const access = request.tool === "read" ? ("read" as const) : ("write" as const);
  let create: "file" | undefined;

  try {
    if (!(await stat(path)).isFile()) return request;

    path = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || request.tool !== "write") throw error;

    path = join(await realpath(dirname(path)), basename(path));
    create = "file";
  }

  const paths = request.sandbox?.paths ?? [];
  const roots = await Promise.all(
    paths.map((entry) =>
      realpath(entry.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;

        return resolve(entry.path);
      }),
    ),
  );
  const covered = roots.some((root) => within(root, path));

  if (!covered && paths.length >= 32)
    throw new Error("Too many selected paths; include the named file in the existing grant list");

  return {
    ...request,
    arguments: { ...request.arguments, path },
    sandbox: {
      ...request.sandbox,
      paths: covered ? paths : [...paths, { path, access, ...(create ? { create } : {}) }],
    },
  };
}
