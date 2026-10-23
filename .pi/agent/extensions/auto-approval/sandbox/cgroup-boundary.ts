import { readFile, realpath, statfs } from "node:fs/promises";
import { within } from "./paths.ts";
import type { Workspace } from "./types.ts";

/** Never expose controller files, including bind aliases or cgroups nested under a grant. */
export async function assertCgroupsHidden(workspace: Workspace) {
  if (process.platform !== "linux") return;

  const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .filter((line) => line.includes(" - cgroup2 "))
    .map((line) =>
      line
        .split(" ")[4]!
        .replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8))),
    );
  const sources = [
    ...workspace.bindings,
    ...(workspace.temporaryDirectory ? [workspace.temporaryDirectory] : []),
  ];

  for (const source of sources) {
    const pending = workspace.pendingPaths?.find((entry) => entry.path === source);
    const path = await realpath(pending?.parent ?? source);

    if ((await statfs(path)).type === 0x63677270 || mounts.some((mount) => within(path, mount)))
      throw new Error(`Cgroup controller files must remain outside every sandbox mount: ${source}`);
  }
}
