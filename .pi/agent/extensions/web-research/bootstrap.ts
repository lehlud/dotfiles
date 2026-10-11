// Operator startup only; dependency installation never runs from model tools.
import { access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const directory = import.meta.dir;
const digest = createHash("sha256")
  .update(await readFile(join(directory, "package.json")))
  .update(await readFile(join(directory, "bun.lock")))
  .digest("hex");
const stamp = join(directory, "node_modules/.web-research-dependencies");
let previous = "";
try {
  previous = await readFile(stamp, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (previous !== digest) {
  const result = Bun.spawnSync(
    [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: directory, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode) throw new Error("Web-research extension dependencies unavailable");
  await writeFile(stamp, digest);
}
await access(join(directory, "worker.py"));
if (process.platform === "linux") {
  const setup = Bun.spawnSync(["/usr/bin/python3", join(directory, "setup.py")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (setup.exitCode) throw new Error("Web-research Python setup failed; startup blocked");
}
