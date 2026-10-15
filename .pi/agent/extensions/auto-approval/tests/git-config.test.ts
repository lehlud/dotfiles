import { beforeAll, afterAll, test, expect } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Check } from "typebox/value";
import { gitTool, validateGitArgv } from "../git-command.ts";
import { executeWithGitConfig, publicGitConfiguration, validateGitRequest } from "../git-config.ts";
import {
  executeIsolated,
  sandboxArguments,
  validateWorkspace,
  type Workspace,
} from "../isolation.ts";
import type { Config } from "../../shared/configuration/schemas.ts";
import type { Request } from "../../shared/contracts/action.ts";

const fixture = await mkdtemp(join(tmpdir(), "pi-git-test-")),
  project = join(fixture, "project"),
  home = join(fixture, "home"),
  xdg = join(home, ".config");
const bwrap = Bun.which("bwrap"),
  nativeTest = process.platform === "linux" && bwrap ? test : test.skip;
let config: Config, workspace: Workspace;
const action = (argv: string[], grant = true): Request => ({
  tool: "git",
  arguments: { argv },
  sandbox: { gitConfig: grant },
  goal: "Test reviewed Git settings",
  justification: "Commit only synthetic changes in a disposable repository",
});
const text = (result: any) => result.content.map((item: any) => item.text).join("\n") as string;
const originals = new Map<string, string>();

beforeAll(async () => {
  await mkdir(project);
  await mkdir(join(xdg, "git"), { recursive: true });

  for (const [name, content] of [
    [
      join(xdg, "git", "config"),
      "[user]\nname = XDG identity\nemail = xdg@example.invalid\n[color]\nui = false\n",
    ],
    [
      join(home, ".gitconfig"),
      `[user]\nname = Global identity\nemail = global@example.invalid\n[include]\npath = identity.inc\n[includeIf "gitdir:${project}/"]\npath = conditional.inc\n[includeIf "gitdir:/not-this-project/"]\npath = unrelated.inc\n[credential]\nhelper = !echo synthetic-private-token\n[http]\nextraHeader = Authorization: synthetic-private-token\n[alias]\nspy = !cat /opt/pi-git/config\n[core]\nhooksPath = /host/hooks\nfsmonitor = /host/monitor\n[diff]\nexternal = /host/diff\n`,
    ],
    [
      join(home, "identity.inc"),
      '[user]\nname = "Ada Grüße 雪"\nemail = included@example.invalid\n[commit]\ngpgsign = false\n',
    ],
    [join(home, "conditional.inc"), "[user]\nemail = conditional@example.invalid\n"],
    [join(home, "unrelated.inc"), "[user]\nname = Wrong conditional identity\n"],
  ]) {
    originals.set(name, content);
    await writeFile(name, content);
  }

  const init = Bun.spawnSync(["/usr/bin/git", "init", "-q", project], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (init.exitCode) throw new Error(init.stderr.toString());

  await writeFile(join(project, "file"), "synthetic change\n");

  if (!bwrap) return;

  const runner = join(fixture, "runner");
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
    reviewers: [{ provider: "openai", model: "fixture", thinking: "off" }],
    recentUserPrompts: 6,
    requestTimeoutMs: 1000,
    sandbox: { backend: "bwrap", executable: bwrap, runnerExecutable: runner },
  };
  workspace = await validateWorkspace(project, config.sandbox, []);
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

test("Git arguments exclude shell, aliases, executable overrides and remote/destructive commands", () => {
  expect(Check(gitTool.parameters, { argv: ["commit", "-m", "literal $(no shell); Grüße"] })).toBe(
    true,
  );

  for (const args of [
    { argv: [] },
    { argv: ["status"], environment: { TOKEN: "private" } },
    { argv: ["status\0"] },
    { command: "git commit" },
  ])
    expect(Check(gitTool.parameters, args)).toBe(false);

  for (const argv of [
    ["push"],
    ["reset", "--hard"],
    ["spy"],
    ["config", "--global", "user.name", "new"],
    ["-c", "user.email=override", "commit"],
    ["--exec-path=/tmp", "status"],
    ["diff", "--ext-diff"],
    ["show", "--textconv"],
  ])
    expect(() => validateGitArgv(argv)).toThrow();

});

test("only explicit supported public values survive, with native Git quoting preserved", () => {
  const publicText = publicGitConfiguration([
    ["user.name", 'A "quote" \\ path\nGrüße'],
    ["user.email", "test@example.invalid"],
    ["credential.helper", "private-token"],
    ["http.extraheader", "private-token"],
    ["alias.spy", "!env"],
    ["core.hooksPath", "/private"],
    ["gpg.program", "/private"],
  ]);

  expect(publicText).toContain('name = "A \\"quote\\" \\\\ path\\nGrüße"');
  expect(publicText).not.toContain("private");
  expect(publicText).not.toContain("alias");
  expect(() => publicGitConfiguration([["user.name", "bad\0"]])).toThrow();
});

nativeTest(
  "the configuration flag is Git-only and cannot expand executable, environment or network scope",
  () => {
    for (const request of [
      { ...action(["status"]), tool: "bash", arguments: { command: "env" } },
      ...[
        { tools: ["node"] },
        { environment: { GIT_CONFIG_GLOBAL: "/host" } },
        { executableSearchPaths: ["/tmp"] },
        { network: "host" as const },
      ].map((sandbox) => ({ ...action(["status"]), sandbox })),
    ])
      expect(() => validateGitRequest(request, config)).toThrow();

    expect(() => validateGitRequest(action(["commit", "-m", "safe"]), config)).not.toThrow();
  },
);
nativeTest(
  "real Git commits with included global identity, without mutating global or local config",
  async () => {
    const localConfig = await readFile(join(project, ".git", "config"), "utf8");

    expect(
      (await executeIsolated(action(["add", "file"], false), workspace, config.sandbox)).isError,
    ).not.toBe(true);

    const noGrant = await executeIsolated(
      action(["commit", "-m", "must fail"], false),
      workspace,
      config.sandbox,
    );

    expect(noGrant.isError).toBe(true);
    expect(text(noGrant)).toContain("identity");

    const committed = await executeWithGitConfig(
      action(["commit", "-m", "Reviewed identity fixture"]),
      workspace,
      config,
      undefined,
      home,
      xdg,
    );

    expect(committed.isError).not.toBe(true);
    expect(text(committed)).not.toContain("synthetic-private-token");

    const identity = await executeIsolated(
      action(["log", "-1", "--format=%an|%ae|%cn|%ce"], false),
      workspace,
      config.sandbox,
    );

    expect(text(identity).trim()).toBe(
      "Ada Grüße 雪|conditional@example.invalid|Ada Grüße 雪|conditional@example.invalid",
    );

    for (const [path, content] of originals) expect(await readFile(path, "utf8")).toBe(content);

    expect(await readFile(join(project, ".git", "config"), "utf8")).toBe(localConfig);
  },
);
nativeTest("the public snapshot is read-only, and disappears from later commands", async () => {
  const source = join(fixture, "public-copy");

  await writeFile(source, "[user]\nname = synthetic\nemail = synthetic@example.invalid\n", {
    mode: 0o400,
  });

  const projected = { ...workspace, gitSnapshots: [{ source, target: "/opt/pi-git/config" }] };
  const args = sandboxArguments(projected, config.sandbox, "fixture");
  const index = args.indexOf(source);

  expect(args[index - 1]).toBe("--ro-bind");

  const mutation: Request = {
    tool: "bash",
    arguments: { command: "printf changed > /opt/pi-git/config" },
    goal: "Test immutable projection",
    justification: "Use a synthetic copy only",
  };

  expect((await executeIsolated(mutation, projected, config.sandbox)).isError).toBe(true);

  const ordinary = await executeIsolated(
    {
      ...mutation,
      arguments: {
        command:
          'test ! -e /opt/pi-git/config && test ! -e "$HOME/.gitconfig" && test -z "$GIT_AUTHOR_EMAIL"',
      },
    },
    workspace,
    config.sandbox,
  );

  expect(ordinary.isError).not.toBe(true);

  const before = new Set(
    (await readdir(tmpdir())).filter((name) => name.startsWith("pi-git-config-")),
  );

  expect(
    (
      await executeWithGitConfig(
        action(["status", "--short"]),
        workspace,
        config,
        undefined,
        home,
        xdg,
      )
    ).isError,
  ).not.toBe(true);
  expect(
    new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-git-config-"))),
  ).toEqual(before);
});

nativeTest(
  "native Git resolves symlinked operator files and supports XDG-only or explicit global config",
  async () => {
    const alternate = join(fixture, "other-home"),
      alternateXdg = join(alternate, ".config");

    await mkdir(join(alternateXdg, "git"), { recursive: true });

    const identity = "[user]\nname = Alternate identity\nemail = alternate@example.invalid\n";

    await writeFile(join(alternateXdg, "git", "config"), identity);

    const status = action(["status", "--short"]);

    expect(
      (await executeWithGitConfig(status, workspace, config, undefined, alternate, alternateXdg))
        .isError,
    ).not.toBe(true);
    await symlink(join(alternateXdg, "git", "config"), join(alternate, ".gitconfig"));
    expect(
      (await executeWithGitConfig(status, workspace, config, undefined, alternate, alternateXdg))
        .isError,
    ).not.toBe(true);
    expect(
      (
        await executeWithGitConfig(
          status,
          workspace,
          config,
          undefined,
          alternate,
          alternateXdg,
          join(alternate, ".gitconfig"),
        )
      ).isError,
    ).not.toBe(true);
  },
);
nativeTest(
  "explicitly reviewed config edits still work through ordinary read/write path grants",
  async () => {
    const path = join(fixture, "editable.gitconfig");

    await writeFile(path, "before");
    await chmod(path, 0o600);

    const scope = { paths: [{ path, access: "write" as const }] };
    const allowed = await validateWorkspace(project, config.sandbox, [], scope);
    const request: Request = {
      tool: "write",
      arguments: { path, content: "requested change" },
      sandbox: scope,
      goal: "Operator-requested config change",
      justification: "Mutate only the selected synthetic config",
    };

    expect((await executeIsolated(request, allowed, config.sandbox)).isError).not.toBe(true);
    expect(await readFile(path, "utf8")).toBe("requested change");
  },
);
nativeTest(
  "missing global config does not block local inspection and never invents an identity",
  async () => {
    const emptyHome = join(fixture, "empty-home");

    await mkdir(emptyHome);

    const result = await executeWithGitConfig(
      action(["status", "--short"]),
      workspace,
      config,
      undefined,
      emptyHome,
      join(emptyHome, ".config"),
    );

    expect(result.isError).not.toBe(true);
  },
);
nativeTest(
  "parse failures and cancellation remove private snapshots without returning their contents",
  async () => {
    const invalid = join(fixture, "invalid.gitconfig");

    await writeFile(invalid, "[invalid-synthetic-private-token\n");

    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("pi-git-config-")),
    );

    await expect(
      executeWithGitConfig(action(["status"]), workspace, config, undefined, home, xdg, invalid),
    ).rejects.toThrow("Global Git configuration could not be parsed");

    const controller = new AbortController();

    controller.abort();
    await expect(
      executeWithGitConfig(action(["status"]), workspace, config, controller.signal, home, xdg),
    ).rejects.toThrow();
    expect(
      new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-git-config-"))),
    ).toEqual(before);
  },
);
