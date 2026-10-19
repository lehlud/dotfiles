// Operator startup only. Never called by an agent tool or from inside Pi.
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

async function fingerprint(directory: string, files: string[]): Promise<string> {
  const hash = createHash("sha256").update(`${process.platform}/${process.arch}/${Bun.version}\0`);

  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(directory, file)))
      .update("\0");

  return hash.digest("hex");
}

async function matches(path: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).trim() === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    return false;
  }
}

function run(directory: string, args: string[]): void {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.exitCode !== 0)
    throw new Error(`Auto-Approval setup failed: bun ${args[0]} (exit ${result.exitCode})`);
}

/** The separate extensions share the SDK dependencies pinned here. */
export async function prepareCompanionDependencies(directory: string): Promise<void> {
  for (const name of [
    "shared",
    "conversations",
    "multiplex",
    "provider-recovery",
    "code-quality",
    "fast-mode",
  ]) {
    const companion = join(dirname(directory), name);

    try {
      await access(join(companion, name === "shared" ? "configuration/load.ts" : "index.ts"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;

      throw error;
    }

    const modules = join(companion, "node_modules");

    try {
      await symlink("../auto-approval/node_modules", modules, "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if ((await realpath(modules)) !== (await realpath(join(directory, "node_modules"))))
      throw new Error(
        `${name}: node_modules must refer to the pinned Auto-Approval SDK dependencies`,
      );
  }
}

export async function prepareExecutor(
  directory: string,
  home = homedir(),
  agentDirectory = dirname(dirname(directory)),
): Promise<void> {
  const dependencies = await fingerprint(directory, ["package.json", "bun.lock"]);
  const dependencyStamp = join(directory, "node_modules", ".auto-approval-dependencies");

  if (!(await matches(dependencyStamp, dependencies))) {
    run(directory, ["install", "--frozen-lockfile", "--ignore-scripts"]);
    await writeFile(dependencyStamp, `${dependencies}\n`);
  }

  await prepareCompanionDependencies(directory);

  const { assertSandboxReady, loadConfig } = (await import(
    join(directory, "../shared/configuration/load.ts")
  )) as typeof import("../shared/configuration/load.ts");
  const config = await loadConfig(agentDirectory, { home });

  if (config.sandbox.backend !== "bwrap") return;

  const runner = join(home, ".local", "cache", "pi-auto-approval", "executor");

  // Custom device executors are operator-managed; never replace them.
  if (config.sandbox.runnerExecutable !== runner) return await assertSandboxReady(config);

  const sources = await fingerprint(directory, [
    "runner.ts",
    "credential-command.ts",
    "../shared/configuration/credential-profile.ts",
    "git-command.ts",
    "git-process.ts",
    "git-rebase.ts",
    "package.json",
    "bun.lock",
    "../web-research/index.ts",
    "../web-research/execute.ts",
    "../web-research/package.json",
    "../web-research/bun.lock",
    "../public-writing/index.ts",
    "../public-writing/rules.ts",
    "../public-writing/package.json",
    "../public-writing/bun.lock",
  ]);
  let executable = false;

  try {
    await access(runner, constants.R_OK | constants.X_OK);
    executable = (await stat(runner)).isFile();
  } catch (error) {
    if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }

  if (!executable || !(await matches(`${runner}.sources.sha256`, sources))) {
    await mkdir(dirname(runner), { recursive: true });

    const staging = await mkdtemp(join(dirname(runner), ".build-"));

    try {
      const candidate = join(staging, "executor");

      run(directory, ["build", "--compile", "runner.ts", "--outfile", candidate]);
      await chmod(candidate, 0o755);
      // Atomic replacement keeps executors already mounted by running Pi usable.
      await rename(candidate, runner);
      await writeFile(`${runner}.sources.sha256`, `${sources}\n`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  await assertSandboxReady(config);
}

if (import.meta.main) {
  try {
    await prepareExecutor(
      import.meta.dir,
      homedir(),
      process.env.PI_CODING_AGENT_DIR ?? dirname(dirname(import.meta.dir)),
    );
  } catch (error) {
    console.error(`pi: ${String(error)}; startup blocked`);
    process.exitCode = 1;
  }
}

