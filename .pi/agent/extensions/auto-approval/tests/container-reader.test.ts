import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { containerFileReader } from "../container-reader.ts";
import type { Config } from "../../shared/configuration/schemas.ts";

const native = process.platform === "linux" && Bun.which("bwrap") ? test : test.skip;

native(
  "isolated configuration snapshots preserve large Unicode inputs and reject external aliases",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-container-reader-"));

    try {
      const runner = join(directory, "runner");
      const build = Bun.spawnSync([
        process.execPath,
        "build",
        "--compile",
        resolve(import.meta.dir, "../runner.ts"),
        "--outfile",
        runner,
      ]);

      expect(build.exitCode).toBe(0);

      const project = join(directory, "project");

      await mkdir(project);

      const text = "# exact-source fixture\n" + "# Unicode: ä雪\n".repeat(6000);
      const path = join(project, "compose.yaml");

      await writeFile(path, text);

      const config = {
        sandbox: { backend: "bwrap", executable: Bun.which("bwrap"), runnerExecutable: runner },
      } as Config;
      const read = containerFileReader(
        { path: project, cwd: project, bindings: [project], masked: [] },
        config,
      );
      const result = (await read([path]))[0];

      expect("errorCode" in result).toBe(false);

      if ("errorCode" in result) throw new Error(result.errorCode);

      expect(Buffer.byteLength(result.source)).toBeGreaterThan(100000);
      expect(result.source).toBe(text);

      const outside = join(directory, "outside-secret");

      await writeFile(outside, "synthetic-outside-data");
      await symlink(outside, join(project, "alias"));
      await expect(read([join(project, "alias")])).rejects.toThrow("inspection failed");
      expect(await read([join(project, "missing")])).toEqual([{ errorCode: "ENOENT" }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
