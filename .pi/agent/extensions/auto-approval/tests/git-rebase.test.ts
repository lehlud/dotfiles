import { beforeAll, afterAll, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateGitArgv } from "../git-command.ts";
import { executeWithGitConfig } from "../git-config.ts";
import { executeIsolated, validateWorkspace, type Workspace } from "../isolation.ts";
import type { Config } from "../../shared/configuration/schemas.ts";
import type { Request } from "../../shared/contracts/action.ts";

const root = await mkdtemp(join(tmpdir(), "pi-rebase-test-"));
const home = join(root, "home");
const xdg = join(home, ".config");
const bwrap = Bun.which("bwrap");
const nativeTest = process.platform === "linux" && bwrap ? test : test.skip;
const publicConfig =
  "[user]\nname = Reviewed identity\nemail = reviewed@example.invalid\n[commit]\ngpgsign = false\n";
let config: Config;
let serial = 0;

type Repository = { path: string; workspace: Workspace; original: string; upstream: string };

function git(path: string, ...argv: string[]): string {
  const result = Bun.spawnSync(["/usr/bin/git", ...argv], {
    cwd: path,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Original author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_COMMITTER_NAME: "Fixture committer",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_EDITOR: "/usr/bin/false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

async function commit(path: string, file: string, value: string, message: string) {
  await writeFile(join(path, file), value);
  git(path, "add", file);
  git(path, "commit", "-qm", message);
}

async function repository(conflict = false): Promise<Repository> {
  const path = join(root, `project-${++serial}`);

  await mkdir(path);
  git(path, "init", "-q", "-b", "main");
  await commit(path, "shared", "base\n", "Base");
  git(path, "switch", "-qc", "lkl/rush");

  if (conflict) await commit(path, "shared", "feature\n", "Prepared feature message");
  else {
    for (let index = 0; index < 4; index++) {
      await commit(path, `feature-${index}`, `feature ${index}\n`, `Feature ${index}`);
    }
  }

  const original = git(path, "rev-parse", "HEAD");

  git(path, "branch", "backup/before-rebase");
  git(path, "switch", "-q", "main");
  await commit(path, conflict ? "shared" : "upstream", "upstream\n", "Main advance");

  const upstream = git(path, "rev-parse", "HEAD");

  git(path, "switch", "-q", "lkl/rush");

  return { path, original, upstream, workspace: await validateWorkspace(path, config.sandbox, []) };
}

function action(argv: string[], grant = true): Request {
  return {
    tool: "git",
    arguments: { argv },
    sandbox: { gitConfig: grant },
    goal: "Rebase a synthetic local branch",
    justification: "Exercise one authorized Git invocation in a disposable repository",
  };
}

function run(repo: Repository, argv: string[], grant = true) {
  const request = action(argv, grant);

  return grant
    ? executeWithGitConfig(request, repo.workspace, config, undefined, home, xdg)
    : executeIsolated(request, repo.workspace, config.sandbox);
}

function text(result: any): string {
  return result.content.map((item: any) => item.text ?? "").join("\n");
}

async function startConflict(repo: Repository) {
  const result = await run(repo, ["rebase", repo.upstream, "lkl/rush"]);

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("CONFLICT");
}

beforeAll(async () => {
  await mkdir(xdg, { recursive: true });
  await writeFile(join(home, ".gitconfig"), publicConfig);

  if (!bwrap) return;

  const runner = join(root, "runner");
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      resolve(import.meta.dir, "../runner.ts"),
      "--outfile",
      runner,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (built.exitCode) throw new Error(built.stderr.toString());

  config = {
    reviewer: { provider: "openai", model: "fixture", thinking: "off" },
    recentUserPrompts: 6,
    requestTimeoutMs: 1000,
    sandbox: { backend: "bwrap", executable: bwrap, runnerExecutable: runner },
  };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("noninteractive rebase arguments are supported without widening other Git commands", () => {
  for (const argv of [
    ["rebase", "main", "lkl/rush"],
    ["rebase", "--onto", "main", "old", "feature"],
    ["rebase", "--continue"],
    ["rebase", "--abort"],
    ["rebase", "--skip"],
    ["rebase", "-s", "ort", "-Xtheirs", "main"],
    ["rebase", "-sort", "main"],
    ["rebase", "--strategy=ort", "--strategy-option=theirs", "main"],
    ["rebase", "-X", "theirs", "main"],
    ["rebase", "-S", "main"],
  ])
    expect(() => validateGitArgv(argv)).not.toThrow();

  for (const argv of [
    ["rebase", "--exec", "echo unsafe"],
    ["rebase", "--ex=echo unsafe"],
    ["rebase", "-qxecho unsafe"],
    ["rebase", "-S", "--exec", "echo unsafe"],
    ["rebase", "-S", "--interactive"],
    ["rebase", "-S", "-sexternal"],
    ["rebase", "--interactive"],
    ["rebase", "-qi"],
    ["rebase", "--edit-todo"],
    ["rebase", "--strategy=external"],
    ["rebase", "-sexternal"],
    ["reset", "--hard"],
    ["push"],
    ["merge", "main"],
    ["-c", "alias.spy=!env", "spy"],
  ])
    expect(() => validateGitArgv(argv)).toThrow();
});

nativeTest(
  "rebases four commits with projected identity and preserves author, backup and configs",
  async () => {
    const repo = await repository();

    git(repo.path, "config", "rebase.updateRefs", "true");

    const localConfig = await readFile(join(repo.path, ".git/config"), "utf8");
    const result = await run(repo, ["rebase", repo.upstream, "lkl/rush"]);

    expect(result.isError).not.toBe(true);
    expect(git(repo.path, "rev-list", "--count", "main..HEAD")).toBe("4");
    expect(git(repo.path, "rev-parse", "HEAD")).not.toBe(repo.original);
    expect(git(repo.path, "rev-parse", "backup/before-rebase")).toBe(repo.original);
    expect(git(repo.path, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe(
      "Original author|author@example.invalid|Reviewed identity|reviewed@example.invalid",
    );
    expect(git(repo.path, "status", "--porcelain")).toBe("");
    expect(await readFile(join(repo.path, ".git/config"), "utf8")).toBe(localConfig);
    expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe(publicConfig);
  },
);

nativeTest(
  "conflict continuation keeps the prepared message and does not run hooks or editors",
  async () => {
    const repo = await repository(true);
    const marker = join(repo.path, "unexpected-program");
    const program = join(repo.path, "unexpected.sh");

    await writeFile(program, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(repo.path, "config", "core.editor", program);
    git(repo.path, "config", "sequence.editor", program);

    for (const hook of ["pre-rebase", "post-rewrite", "prepare-commit-msg"]) {
      await writeFile(join(repo.path, ".git/hooks", hook), `#!/bin/sh\ntouch '${marker}'\n`, {
        mode: 0o755,
      });
    }

    // A generated todo must treat a formatted commit subject as data, never as a shell step.
    git(repo.path, "config", "rebase.instructionFormat", `%s%nexec ${program}`);
    await startConflict(repo);
    await writeFile(join(repo.path, "shared"), "resolved\n");
    expect((await run(repo, ["add", "shared"], false)).isError).not.toBe(true);

    const missingIdentity = await run(repo, ["rebase", "--continue"], false);

    expect(missingIdentity.isError).toBe(true);
    expect(text(missingIdentity)).toContain("identity");

    const continued = await run(repo, ["rebase", "--continue"]);

    expect(continued.isError).not.toBe(true);
    expect(git(repo.path, "log", "-1", "--format=%s|%cn|%ce")).toBe(
      "Prepared feature message|Reviewed identity|reviewed@example.invalid",
    );
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(repo.path, ".git/rebase-merge/git-rebase-todo")).exists()).toBe(
      false,
    );
    expect(git(repo.path, "rev-parse", "backup/before-rebase")).toBe(repo.original);
  },
);

for (const mode of ["--abort", "--skip"]) {
  nativeTest(
    `conflict recovery ${mode} remains available across separate sandbox calls`,
    async () => {
      const repo = await repository(true);

      await startConflict(repo);

      const recovered = await run(repo, ["rebase", mode]);

      expect(recovered.isError).not.toBe(true);
      expect(git(repo.path, "rev-parse", "HEAD")).toBe(
        mode === "--abort" ? repo.original : repo.upstream,
      );
      expect(git(repo.path, "status", "--porcelain")).toBe("");
      expect(await Bun.file(join(repo.path, ".git/rebase-merge/git-rebase-todo")).exists()).toBe(
        false,
      );
    },
  );
}

for (const instruction of ["exec", "x"]) {
  nativeTest(
    `pending ${instruction} instructions cannot execute, but abort still works`,
    async () => {
      const repo = await repository(true);
      const marker = join(repo.path, "unexpected-shell-step");

      await startConflict(repo);
      await appendFile(
        join(repo.path, ".git/rebase-merge/git-rebase-todo"),
        `\n${instruction} touch '${marker}'\n`,
      );
      await writeFile(join(repo.path, "shared"), "resolved\n");
      await run(repo, ["add", "shared"], false);

      await expect(run(repo, ["rebase", "--continue"])).rejects.toThrow(
        "Pending rebase contains shell steps",
      );
      expect(await Bun.file(marker).exists()).toBe(false);
      expect((await run(repo, ["rebase", "--abort"])).isError).not.toBe(true);
      expect(git(repo.path, "rev-parse", "HEAD")).toBe(repo.original);
    },
  );
}

for (const key of [
  "merge.private.driver",
  "filter.private.clean",
  "branch.lkl/rush.mergeOptions",
  "gpg.program",
]) {
  nativeTest(
    `repository executable setting ${key} cannot run through the Git-only route`,
    async () => {
      const repo = await repository();
      const marker = join(repo.path, "unexpected-driver");

      git(repo.path, "config", key, `touch '${marker}'`);

      const error = await run(repo, ["rebase", repo.upstream, "lkl/rush"]).catch(
        (error: Error) => error,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /separately reviewed tool workflow|Custom signing programs/,
      );
      expect((error as Error).message).not.toContain(marker);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(git(repo.path, "rev-parse", "HEAD")).toBe(repo.original);
    },
  );
}

