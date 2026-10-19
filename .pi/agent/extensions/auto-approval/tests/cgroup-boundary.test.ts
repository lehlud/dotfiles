import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertCgroupsHidden } from "../sandbox/cgroup-boundary.ts";

const linux = process.platform === "linux" ? test : test.skip;
const workspace = (bindings: string[]) => ({
  path: "/project",
  cwd: "/project",
  bindings,
  masked: [],
});

linux("controller trees, individual files and containing mounts are always rejected", async () => {
  for (const path of ["/sys/fs/cgroup", "/sys/fs/cgroup/cgroup.procs", "/sys", "/"]) {
    await expect(assertCgroupsHidden(workspace([path]))).rejects.toThrow("Cgroup controller files");
  }
});

linux("symlink aliases and private temporary storage cannot expose controllers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cgroup-boundary-"));

  try {
    const alias = join(root, "alias");

    await symlink("/sys/fs/cgroup", alias);
    await expect(assertCgroupsHidden(workspace([alias]))).rejects.toThrow(
      "Cgroup controller files",
    );
    await expect(
      assertCgroupsHidden({ ...workspace([]), temporaryDirectory: alias }),
    ).rejects.toThrow("Cgroup controller files");
    await mkdir(join(root, "public"));
    await expect(assertCgroupsHidden(workspace([join(root, "public")]))).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
