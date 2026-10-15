import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Check } from "typebox/value";
import { credentialCommandTool, type CredentialProfile } from "../credential-command.ts";
import {
  credentialProtectedPaths,
  credentialReviewPlan,
  executeWithCredentials,
  matchesCredentialArgv,
  resolveCredentialPlan,
  resolveGithubCredential,
} from "../credential-access.ts";
import { executeIsolated, sandboxArguments, validateWorkspace } from "../isolation.ts";
import { parseLocalConfig, type Config } from "../../shared/configuration/schemas.ts";
import { type Request } from "../../shared/contracts/action.ts";

const fixture = await mkdtemp(join(tmpdir(), "pi-credentials-test-"));
const bwrap = Bun.which("bwrap");
const nativeTest = process.platform === "linux" && bwrap ? test : test.skip;
let config: Config, profile: CredentialProfile;
const token = "synthetic-private-token-0246813579";
const secretPath = join(fixture, "login-token");
const project = join(fixture, "project");
const request = (argv = ["inspect"]): Request => ({
  tool: "credential_exec",
  arguments: { profile: "fixture", argv },
  sandbox: { network: "host" },
  goal: "Test authenticated CLI delegation",
  justification: "Use only synthetic credentials in disposable fixtures",
});

beforeAll(async () => {
  await mkdir(project);
  await writeFile(join(project, "private-source"), "unmounted project contents");
  await writeFile(secretPath, token, { mode: 0o600 });

  if (!bwrap) return;

  const executable = join(fixture, "cli"),
    runner = join(fixture, "runner");
  const source = join(fixture, "cli.ts");

  await writeFile(
    source,
    `import { existsSync, writeFileSync } from "node:fs";
    if (process.argv.includes("--")) throw new Error("unexpected shell parsing");
    const mode = process.argv[2];
    console.log(JSON.stringify({cwd:process.cwd(),project:existsSync(${JSON.stringify(join(project, "private-source"))}),hostTmp:existsSync(${JSON.stringify(join(fixture, "host-only"))}),priorTmp:existsSync("/tmp/credential-leftover"),network:require("node:fs").readlinkSync("/proc/self/ns/net"),envNames:Object.keys(process.env).sort(),literalArgs:process.argv.slice(2)}));
    if(mode==="inspect") { const bytes=Buffer.from(process.env.SERVICE_TOKEN!);process.stdout.write(bytes.subarray(0,1));await new Promise(resolve=>setTimeout(resolve,20));process.stdout.write(bytes.subarray(1));console.log();console.log(bytes.toString("base64"));writeFileSync("/tmp/credential-leftover",process.env.SERVICE_TOKEN!); }
    if(mode==="sleep") await new Promise(resolve=>setTimeout(resolve,30000));
    if(mode==="fail") process.exitCode=7;
    if(mode==="read-file") console.log(require("node:fs").readFileSync(process.argv[3],"utf8"));
    if(mode==="write-file") writeFileSync(process.argv[3],"reviewed output");
    if(mode==="service") { const response=await fetch(process.env.SERVICE_URL!,{method:"POST",headers:{Authorization:"Bearer "+process.env.SERVICE_TOKEN},body:JSON.stringify({operation:"close",number:process.argv[3]})}); console.log(await response.text()); if(!response.ok)process.exitCode=1; }
  `,
  );

  for (const [sourcePath, output] of [
    [source, executable],
    [resolve(import.meta.dir, "../runner.ts"), runner],
  ]) {
    const built = Bun.spawnSync(
      [process.execPath, "build", "--compile", sourcePath, "--outfile", output],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (built.exitCode !== 0) throw new Error(built.stderr.toString());

  }

  profile = {
    name: "fixture",
    executable,
    allowedArgv: [[{ pattern: "inspect|check|fail|sleep" }]],
    secrets: { SERVICE_TOKEN: { type: "file", path: secretPath } },
  };
  config = {
    reviewers: [{ provider: "openai", model: "gpt-6-luna", thinking: "medium" }],
    recentUserPrompts: 6,
    requestTimeoutMs: 120000,
    sandbox: { backend: "bwrap", executable: bwrap, runnerExecutable: runner },
    credentialProfiles: [profile],
  };
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

test("command schema excludes shell text, executable paths and secret-bearing additions", () => {
  expect(
    Check(credentialCommandTool.parameters, {
      profile: "github",
      argv: ["pr", "view", "1", "-R", "owner/repo"],
    }),
  ).toBe(true);

  for (const args of [
    { profile: "github", command: "gh auth token" },
    { profile: "github", argv: ["pr", "view"], executable: "/bin/sh" },
    { profile: "github", argv: ["bad\0value"] },
    { profile: "github", argv: [], token },
  ])
    expect(Check(credentialCommandTool.parameters, args)).toBe(false);

});

test("operator profiles match entire argv sequences and reject undocumented sources", () => {
  const rule: CredentialProfile = {
    name: "service",
    executable: "/usr/bin/service",
    secrets: { TOKEN: { type: "environment", name: "SERVICE_TOKEN" } },
    allowedArgv: [[{ literal: "close" }, { pattern: "[0-9]+" }]],
  };

  expect(matchesCredentialArgv(rule, ["close", "123"])).toBe(true);

  for (const argv of [
    ["close", "123-extra"],
    ["close", "123\n"],
    ["close", "123", "--token"],
    ["auth", "123"],
  ])
    expect(matchesCredentialArgv(rule, argv)).toBe(false);

  expect(
    parseLocalConfig(JSON.stringify({ credentialProfiles: [rule] })).credentialProfiles,
  ).toEqual([rule]);
  expect(() =>
    parseLocalConfig(
      JSON.stringify({
        credentialProfiles: [
          { ...rule, secrets: { TOKEN: { type: "command", command: "printenv" } } },
        ],
      }),
    ),
  ).toThrow();
});

test("review-mode program/login bindings do not invent operation permission or silently loosen existing allowlists", () => {
  const reviewed: CredentialProfile = {
    name: "service",
    executable: "/usr/bin/service",
    argumentPolicy: "review",
    secrets: { TOKEN: { type: "environment", name: "SERVICE_TOKEN" } },
  };

  expect(
    parseLocalConfig(JSON.stringify({ credentialProfiles: [reviewed] })).credentialProfiles,
  ).toEqual([reviewed]);

  for (const argv of [
    ["inspect"],
    ["new-command", "--target", "42"],
    ["api", "--method", "GET", "repos/owner/repo/dependabot/alerts?state=open"],
  ])
    expect(matchesCredentialArgv(reviewed, argv)).toBe(true);

  for (const profile of [
    { ...reviewed, allowedArgv: [[{ literal: "inspect" }]] },
    { ...reviewed, argumentPolicy: "unchecked" },
    { name: reviewed.name, executable: reviewed.executable, secrets: reviewed.secrets },
  ])
    expect(() => parseLocalConfig(JSON.stringify({ credentialProfiles: [profile] }))).toThrow();

});

nativeTest(
  "the GitHub binding accepts complete argv for independent review, including Dependabot and unrelated operations",
  async () => {
    for (const argv of [
      ["api", "--paginate", "repos/stuck-lehnert/sortsys/dependabot/alerts?state=open"],
      ["api", "-X", "PATCH", "repos/owner/repo/issues/42", "-f", "state=closed"],
      ["auth", "token"],
    ]) {
      const action = { ...request(), arguments: { profile: "github", argv } };
      const plan = await resolveCredentialPlan(action, config),
        metadata = credentialReviewPlan(plan);

      expect(plan.github).toBe(true);
      expect(metadata.argv).toEqual(argv);
      expect(metadata.argumentPolicy).toBe("review");
      expect(metadata.operatorArgumentMatch).toBeUndefined();
      expect(metadata.argumentAuthorization).toContain("not user authorization");
      expect(JSON.stringify(metadata)).not.toContain(token);
    }

  },
);

nativeTest("profile validation reads no credentials and fails closed before review", async () => {
  const missingProfile = {
    ...profile,
    secrets: { SERVICE_TOKEN: { type: "file" as const, path: join(fixture, "missing-token") } },
  };

  expect(
    (await resolveCredentialPlan(request(), { ...config, credentialProfiles: [missingProfile] }))
      .profile,
  ).toBe("fixture");
  await expect(resolveCredentialPlan(request(["dump-token"]), config)).rejects.toThrow("outside");
  expect(
    (await resolveCredentialPlan({ ...request(), sandbox: { network: "none" } }, config)).profile,
  ).toBe("fixture");

  for (const sandbox of [
    { network: "host" as const, environment: { LD_PRELOAD: "/tmp/hook" } },
    { tools: ["node"] },
  ])
    await expect(resolveCredentialPlan({ ...request(), sandbox }, config)).rejects.toThrow();

  const script = join(fixture, "script");

  await writeFile(script, "#!/bin/sh\nprintenv\n", { mode: 0o700 });
  await expect(
    resolveCredentialPlan(request(), {
      ...config,
      credentialProfiles: [{ ...profile, executable: script }],
    }),
  ).rejects.toThrow("native Linux ELF");
  await expect(
    resolveCredentialPlan(request(), {
      ...config,
      sandbox: {
        backend: "docker",
        dockerExecutable: "/usr/bin/docker",
        image: `sha256:${"a".repeat(64)}`,
      },
    }),
  ).rejects.toThrow("requires native Linux bwrap");
});

nativeTest(
  "credential sources and binaries stay protected from ordinary sandbox actions",
  async () => {
    expect(credentialProtectedPaths(config)).toContain(secretPath);
    await expect(
      validateWorkspace(project, config.sandbox, credentialProtectedPaths(config), {
        paths: [{ path: secretPath, access: "read" }],
      }),
    ).rejects.toThrow("protected");
    await expect(
      validateWorkspace(project, config.sandbox, credentialProtectedPaths(config), {
        paths: [{ path: profile.executable, access: "write" }],
      }),
    ).rejects.toThrow("protected");
  },
);
nativeTest(
  "only the selected CLI gets the token; output is redacted and /tmp disappears between calls",
  async () => {
    await writeFile(join(fixture, "host-only"), "outside sandbox");

    const plan = await resolveCredentialPlan(request(), config);

    expect(JSON.stringify(credentialReviewPlan(plan))).not.toContain(token);
    expect(JSON.stringify(credentialReviewPlan(plan))).not.toContain(secretPath);
    expect(JSON.stringify(credentialReviewPlan(plan))).not.toContain(plan.executable);

    const args = sandboxArguments(
      {
        path: "/workspace",
        cwd: "/workspace",
        bindings: [],
        masked: [],
        credentialExecutable: profile.executable,
      },
      config.sandbox,
      "test",
      request().sandbox,
    );

    expect(JSON.stringify(args)).not.toContain(token);
    expect(args).not.toContain("--setenv SERVICE_TOKEN");

    const result = await executeWithCredentials(request(), plan, config);
    const output = JSON.stringify(result);

    expect(result.isError).not.toBe(true);
    expect(output).not.toContain(token);
    expect(output).not.toContain(Buffer.from(token).toString("base64"));
    expect(output).toContain("[REDACTED]");

    const detail = JSON.parse((result.content[0] as any).text.split("\n")[0]);

    expect(detail.cwd).toBe("/workspace");
    expect(detail.project).toBe(false);
    expect(detail.hostTmp).toBe(false);
    expect(detail.priorTmp).toBe(false);
    expect(detail.envNames).toEqual(["HOME", "LANG", "PATH", "SERVICE_TOKEN"]);

    const nextRequest = request(["check"]);
    const next = await executeWithCredentials(
      nextRequest,
      await resolveCredentialPlan(nextRequest, config),
      config,
    );

    expect(JSON.parse((next.content[0] as any).text.split("\n")[0]).priorTmp).toBe(false);

    const ordinary = await executeIsolated(
      {
        tool: "bash",
        arguments: { command: 'test -z "$SERVICE_TOKEN" && test ! -e /tmp/credential-leftover' },
        goal: "Check isolation",
        justification: "Verify secret scope expiry",
      },
      await validateWorkspace(project, config.sandbox, credentialProtectedPaths(config)),
      config.sandbox,
    );

    expect(ordinary.isError).not.toBe(true);
    expect(await readFile(secretPath, "utf8")).toBe(token);
  },
);
nativeTest(
  "changed binaries, unavailable secrets and insecure secret files never run",
  async () => {
    const plan = await resolveCredentialPlan(request(), config);

    await expect(
      executeWithCredentials(request(), { ...plan, executableSha256: "changed" }, config),
    ).rejects.toThrow("changed after review");

    const missing = {
      ...plan,
      secrets: { SERVICE_TOKEN: { type: "file" as const, path: join(fixture, "missing-token") } },
    };

    await expect(executeWithCredentials(request(), missing, config)).rejects.toThrow("ENOENT");
    await chmod(secretPath, 0o644);
    await expect(executeWithCredentials(request(), plan, config)).rejects.toThrow("owner-only");
    await chmod(secretPath, 0o600);

    const alias = join(fixture, "alias");

    await symlink(secretPath, alias);
    await expect(
      executeWithCredentials(
        request(),
        { ...plan, secrets: { SERVICE_TOKEN: { type: "file", path: alias } } },
        config,
      ),
    ).rejects.toThrow();
  },
);
nativeTest("nonzero status and cancellation are preserved without credential output", async () => {
  const failed = request(["fail"]);
  const result = await executeWithCredentials(
    failed,
    await resolveCredentialPlan(failed, config),
    config,
  );

  expect(result.isError).toBe(true);
  expect(result.details.exitCode).toBe(7);

  const sleep = request(["sleep"]),
    controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 200);

  try {
    await expect(
      executeWithCredentials(
        sleep,
        await resolveCredentialPlan(sleep, config),
        config,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
  } finally {
    clearTimeout(timeout);
  }

  expect(JSON.stringify(await readdir(fixture))).not.toContain("credential-leftover");
});

nativeTest(
  "real Linux gh resolves only synthetic credentials through its fixed offline getter",
  async () => {
    const action = {
      ...request(),
      arguments: { profile: "github", argv: ["pr", "view", "1", "--repo", "owner/repo"] },
    };
    const plan = await resolveCredentialPlan(action, config);
    const source = join(fixture, "synthetic-gh"),
      directory = join(fixture, "getter-job");

    await mkdir(source);
    await mkdir(directory);
    await writeFile(
      join(source, "hosts.yml"),
      `github.com:\n    oauth_token: ${token}\n    user: synthetic-test\n    git_protocol: https\n`,
      { mode: 0o600 },
    );
    await writeFile(join(source, "unrelated-login"), "must not be copied", { mode: 0o600 });

    const executable = join(directory, "tool");

    await copyFile(plan.executable, executable);
    await chmod(executable, 0o500);

    const previous = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN];

    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    try {
      const value = await resolveGithubCredential(
        { ...plan, configDirectory: source },
        {
          path: "/workspace",
          cwd: "/workspace",
          bindings: [],
          masked: [],
          credentialExecutable: executable,
        },
        config,
        directory,
      );

      expect(value).toBe(token);
      expect(await readdir(join(directory, "gh"))).toContain("hosts.yml");
      expect(await readdir(join(directory, "gh"))).not.toContain("unrelated-login");
      expect(await readFile(join(source, "hosts.yml"), "utf8")).toContain(token);
    } finally {
      for (const [i, name] of ["GH_TOKEN", "GITHUB_TOKEN"].entries()) {
        if (previous[i] === undefined) delete process.env[name];
        else process.env[name] = previous[i];

      }

    }

  },
);

nativeTest(
  "a general credential profile authenticates exactly its reviewed foreground service operation",
  async () => {
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls++;
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
        expect(request.method).toBe("POST");
        expect(await request.json()).toEqual({ operation: "close", number: "42" });

        return new Response("closed synthetic item 42");
      },
    });

    try {
      const serviceProfile: CredentialProfile = {
        name: profile.name,
        executable: profile.executable,
        secrets: profile.secrets,
        argumentPolicy: "review",
        environment: { SERVICE_URL: server.url.href },
      };
      const serviceConfig = { ...config, credentialProfiles: [serviceProfile] },
        action = request(["service", "42"]);
      const result = await executeWithCredentials(
        action,
        await resolveCredentialPlan(action, serviceConfig),
        serviceConfig,
      );

      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("closed synthetic item 42");
      expect(JSON.stringify(result)).not.toContain(token);
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }

  },
);
nativeTest(
  "real gh performs an authenticated paginated API request through a general binding",
  async () => {
    const builtin = {
      ...request(),
      arguments: {
        profile: "github",
        argv: ["api", "repos/owner/repo/dependabot/alerts?state=open"],
      },
    };
    const installed = await resolveCredentialPlan(builtin, config);
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);

        calls++;
        expect(request.method).toBe("GET");
        expect(url.pathname).toBe("/repos/owner/repo/dependabot/alerts");
        expect(url.searchParams.get("state")).toBe("open");
        expect(request.headers.get("authorization")).toBe(`token ${token}`);

        const page = url.searchParams.get("page") === "2" ? 2 : 1;
        const headers: Record<string, string> =
          page === 1
            ? { Link: `<${url.origin}${url.pathname}?state=open&page=2>; rel="next"` }
            : {};

        return Response.json([{ number: page, dependency: { manifest_path: "package.json" } }], {
          headers,
        });
      },
    });

    try {
      const gh: CredentialProfile = {
        name: "fixture-gh",
        executable: installed.executable,
        argumentPolicy: "review",
        environment: {
          GH_HOST: new URL(server.url).host,
          GH_PROMPT_DISABLED: "1",
          GH_CONFIG_DIR: "/tmp/home/gh",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
        secrets: { GH_ENTERPRISE_TOKEN: { type: "file", path: secretPath } },
      };
      const general = { ...config, credentialProfiles: [gh] };
      const action = {
        ...request(),
        arguments: {
          profile: gh.name,
          argv: ["api", "--paginate", `${server.url}repos/owner/repo/dependabot/alerts?state=open`],
        },
      };
      const result = await executeWithCredentials(
        action,
        await resolveCredentialPlan(action, general),
        general,
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.exitCode).toBe(0);
      expect(calls).toBe(2);

      const output = (result.content[0] as any).text as string;

      expect(output).toContain('"number":1');
      expect(output).toContain('"number":2');
      expect(output).not.toContain(token);
    } finally {
      server.stop(true);
    }

  },
);

nativeTest(
  "selected host environment secrets are redacted across split Unicode output, without inheriting other variables",
  async () => {
    const name = "PI_CREDENTIAL_SYNTHETIC_FIXTURE",
      previous = process.env[name];
    const synthetic = "ä-synthetic-unicode-password-雪";
    const envConfig = {
      ...config,
      credentialProfiles: [
        { ...profile, secrets: { SERVICE_TOKEN: { type: "environment" as const, name } } },
      ],
    };

    try {
      delete process.env[name];

      const plan = await resolveCredentialPlan(request(), envConfig);

      expect(JSON.stringify(credentialReviewPlan(plan))).not.toContain(name);
      await expect(executeWithCredentials(request(), plan, envConfig)).rejects.toThrow(
        "Credential unavailable",
      );
      process.env[name] = synthetic;

      const result = await executeWithCredentials(request(), plan, envConfig);
      const output = (result.content[0] as any).text as string;

      expect(output).not.toContain(synthetic);
      expect(output).not.toContain("synthetic-unicode-password");
      expect(output.trim().split("\n").slice(1)).toEqual(["[REDACTED]", "[REDACTED]"]);

      const detail = JSON.parse(output.split("\n")[0]);

      expect(detail.envNames).not.toContain(name);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;

    }

  },
);
nativeTest(
  "any bound CLI can receive reviewed read/write project or selected-file access, with grants expiring afterwards",
  async () => {
    const reviewed: CredentialProfile = {
      name: profile.name,
      executable: profile.executable,
      argumentPolicy: "review",
      secrets: profile.secrets,
    };
    const general = { ...config, credentialProfiles: [reviewed] },
      file = join(project, "private-source");
    const readScope = { network: "none" as const, projectFiles: "read" as const };
    const read = { ...request(["read-file", file]), sandbox: readScope };
    const projectView = await validateWorkspace(
      project,
      config.sandbox,
      credentialProtectedPaths(general),
      readScope,
    );

    expect(projectView.readOnlyBindings).toContain(project);

    const result = await executeWithCredentials(
      read,
      await resolveCredentialPlan(read, general),
      general,
      undefined,
      projectView,
    );

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("unmounted project contents");
    expect(JSON.parse((result.content[0] as any).text.split("\n")[0]).cwd).toBe(project);

    const deniedWrite = { ...read, arguments: { ...read.arguments, argv: ["write-file", file] } };

    expect(
      (
        await executeWithCredentials(
          deniedWrite,
          await resolveCredentialPlan(deniedWrite, general),
          general,
          undefined,
          projectView,
        )
      ).isError,
    ).toBe(true);
    expect(await readFile(file, "utf8")).toBe("unmounted project contents");

    const writeScope = { projectFiles: "write" as const },
      write = { ...deniedWrite, sandbox: writeScope };
    const writable = await validateWorkspace(
      project,
      config.sandbox,
      credentialProtectedPaths(general),
      writeScope,
    );

    expect(
      (
        await executeWithCredentials(
          write,
          await resolveCredentialPlan(write, general),
          general,
          undefined,
          writable,
        )
      ).isError,
    ).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("reviewed output");

    const selectedScope = { paths: [{ path: file, access: "read" as const }] },
      selected = { ...read, sandbox: selectedScope };
    const selectedView = await validateWorkspace(
      project,
      config.sandbox,
      credentialProtectedPaths(general),
      selectedScope,
      undefined,
      "credential",
    );

    expect(selectedView.bindings).toEqual([file]);
    expect(selectedView.cwd).toBe("/workspace");
    expect(
      (
        await executeWithCredentials(
          selected,
          await resolveCredentialPlan(selected, general),
          general,
          undefined,
          selectedView,
        )
      ).isError,
    ).not.toBe(true);

    const next = request(["check"]),
      isolated = await executeWithCredentials(
        next,
        await resolveCredentialPlan(next, general),
        general,
      );

    expect(JSON.parse((isolated.content[0] as any).text.split("\n")[0]).project).toBe(false);

    for (const access of ["read", "write"] as const)
      await expect(
        validateWorkspace(
          project,
          config.sandbox,
          credentialProtectedPaths(general),
          { paths: [{ path: secretPath, access }] },
          undefined,
          "credential",
        ),
      ).rejects.toThrow("protected");

  },
);
