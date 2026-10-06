import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Check } from "typebox/value";
import { credentialCommandTool, type CredentialProfile } from "../credential-command.ts";
import { credentialProtectedPaths, credentialReviewPlan, executeWithCredentials, matchesCredentialArgv, resolveCredentialPlan, resolveGithubCredential, validateGithubArgv } from "../credential-access.ts";
import { executeIsolated, sandboxArguments, validateWorkspace } from "../isolation.ts";
import { parseLocalConfig, type Config, type Request } from "../policy.ts";

const fixture = await mkdtemp(join(tmpdir(), "pi-credentials-test-"));
const bwrap = Bun.which("bwrap");
const nativeTest = process.platform === "linux" && bwrap ? test : test.skip;
let config: Config, profile: CredentialProfile;
const token = "synthetic-private-token-0246813579";
const secretPath = join(fixture, "login-token");
const project = join(fixture, "project");
const request = (argv = ["inspect"]): Request => ({ tool: "credential_exec", arguments: { profile: "fixture", argv }, sandbox: { network: "host" }, goal: "Test authenticated CLI delegation", justification: "Use only synthetic credentials in disposable fixtures" });
beforeAll(async () => {
  await mkdir(project); await writeFile(join(project, "private-source"), "unmounted project contents");
  await writeFile(secretPath, token, { mode: 0o600 });
  if (!bwrap) return;
  const executable = join(fixture, "cli"), runner = join(fixture, "runner");
  const source = join(fixture, "cli.ts");
  await writeFile(source, `import { existsSync, writeFileSync } from "node:fs";
    if (process.argv.includes("--")) throw new Error("unexpected shell parsing");
    const mode = process.argv[2];
    console.log(JSON.stringify({cwd:process.cwd(),project:existsSync(${JSON.stringify(join(project, "private-source"))}),hostTmp:existsSync(${JSON.stringify(join(fixture, "host-only"))}),priorTmp:existsSync("/tmp/credential-leftover"),network:require("node:fs").readlinkSync("/proc/self/ns/net"),envNames:Object.keys(process.env).sort(),literalArgs:process.argv.slice(2)}));
    if(mode==="inspect") { const bytes=Buffer.from(process.env.SERVICE_TOKEN!);process.stdout.write(bytes.subarray(0,1));await new Promise(resolve=>setTimeout(resolve,20));process.stdout.write(bytes.subarray(1));console.log();console.log(bytes.toString("base64"));writeFileSync("/tmp/credential-leftover",process.env.SERVICE_TOKEN!); }
    if(mode==="sleep") await new Promise(resolve=>setTimeout(resolve,30000));
    if(mode==="fail") process.exitCode=7;
    if(mode==="service") { const response=await fetch(process.env.SERVICE_URL!,{method:"POST",headers:{Authorization:"Bearer "+process.env.SERVICE_TOKEN},body:JSON.stringify({operation:"close",number:process.argv[3]})}); console.log(await response.text()); if(!response.ok)process.exitCode=1; }
  `);
  for (const [sourcePath, output] of [[source, executable], [resolve(import.meta.dir, "../runner.ts"), runner]]) {
    const built = Bun.spawnSync([process.execPath, "build", "--compile", sourcePath, "--outfile", output], { stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  }
  profile = { name: "fixture", executable, allowedArgv: [[{ pattern: "inspect|check|fail|sleep" }]], secrets: { SERVICE_TOKEN: { type: "file", path: secretPath } } };
  config = { reviewers: [{ provider: "openai", model: "gpt-6-luna", thinking: "medium" }], recentUserPrompts: 6, requestTimeoutMs: 120000, sandbox: { backend: "bwrap", executable: bwrap, runnerExecutable: runner }, credentialProfiles: [profile] };
});
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

test("GitHub commands require fixed builtins, numeric target and explicit github.com repository", () => {
  for (const argv of [["pr", "close", "42", "--repo", "owner/repo"], ["pr", "view", "1", "-R", "github.com/owner/repo", "--json", "number,state"], ["issue", "comment", "9", "--repo", "owner/repo", "--body", "$(touch /tmp/no-shell); Grüße"]]) expect(() => validateGithubArgv(argv)).not.toThrow();
  for (const argv of [["auth", "token"], ["api", "/user"], ["evil-extension", "run"], ["pr", "close", "https://evil.test/pr/1", "--repo", "owner/repo"], ["pr", "close", "42"], ["pr", "close", "42", "-R", "evil.test/owner/repo"], ["pr", "close", "42", "--repo", "owner/repo", "--delete-branch"], ["pr", "view", "42", "--repo", "owner/repo", "--web"], ["pr", "view", "42", "--repo", "owner/repo", "--jq", "env"], ["pr", "view", "42", "--repo", "owner/repo", "--template", "env"], ["pr", "close", "42", "--repo", "owner/repo", "-R", "owner/other"]]) expect(() => validateGithubArgv(argv)).toThrow();
});
test("command schema excludes shell text, executable paths and secret-bearing additions", () => {
  expect(Check(credentialCommandTool.parameters, { profile: "github", argv: ["pr", "view", "1", "-R", "owner/repo"] })).toBe(true);
  for (const args of [{ profile: "github", command: "gh auth token" }, { profile: "github", argv: ["pr", "view"], executable: "/bin/sh" }, { profile: "github", argv: ["bad\0value"] }, { profile: "github", argv: [], token }]) expect(Check(credentialCommandTool.parameters, args)).toBe(false);
});
test("operator profiles match entire argv sequences and reject undocumented sources", () => {
  const rule: CredentialProfile = { name: "service", executable: "/usr/bin/service", secrets: { TOKEN: { type: "environment", name: "SERVICE_TOKEN" } }, allowedArgv: [[{ literal: "close" }, { pattern: "[0-9]+" }]] };
  expect(matchesCredentialArgv(rule, ["close", "123"])).toBe(true);
  for (const argv of [["close", "123-extra"], ["close", "123\n"], ["close", "123", "--token"], ["auth", "123"]]) expect(matchesCredentialArgv(rule, argv)).toBe(false);
  expect(parseLocalConfig(JSON.stringify({ credentialProfiles: [rule] })).credentialProfiles).toEqual([rule]);
  expect(() => parseLocalConfig(JSON.stringify({ credentialProfiles: [{ ...rule, secrets: { TOKEN: { type: "command", command: "printenv" } } }] }))).toThrow();
});

nativeTest("profile validation reads no credentials and fails closed before review", async () => {
  const missingProfile = { ...profile, secrets: { SERVICE_TOKEN: { type: "file" as const, path: join(fixture, "missing-token") } } };
  expect((await resolveCredentialPlan(request(), { ...config, credentialProfiles: [missingProfile] })).profile).toBe("fixture");
  await expect(resolveCredentialPlan(request(["dump-token"]), config)).rejects.toThrow("outside");
  for (const sandbox of [{ network: "none" as const }, { network: "host" as const, environment: { LD_PRELOAD: "/tmp/hook" } }, { network: "host" as const, paths: [{ path: secretPath, access: "read" as const }] }]) await expect(resolveCredentialPlan({ ...request(), sandbox }, config)).rejects.toThrow();
  const script = join(fixture, "script"); await writeFile(script, "#!/bin/sh\nprintenv\n", { mode: 0o700 });
  await expect(resolveCredentialPlan(request(), { ...config, credentialProfiles: [{ ...profile, executable: script }] })).rejects.toThrow("native Linux ELF");
  await expect(resolveCredentialPlan(request(), { ...config, sandbox: { backend: "docker", dockerExecutable: "/usr/bin/docker", image: `sha256:${"a".repeat(64)}` } })).rejects.toThrow("requires native Linux bwrap");
});
nativeTest("credential sources and binaries stay protected from ordinary sandbox actions", async () => {
  expect(credentialProtectedPaths(config)).toContain(secretPath);
  await expect(validateWorkspace(project, config.sandbox, credentialProtectedPaths(config), { paths: [{ path: secretPath, access: "read" }] })).rejects.toThrow("protected");
  await expect(validateWorkspace(project, config.sandbox, credentialProtectedPaths(config), { paths: [{ path: profile.executable, access: "write" }] })).rejects.toThrow("protected");
});
nativeTest("only the selected CLI gets the token; output is redacted and /tmp disappears between calls", async () => {
  await writeFile(join(fixture, "host-only"), "outside sandbox");
  const plan = await resolveCredentialPlan(request(), config);
  expect(JSON.stringify(credentialReviewPlan(plan))).not.toContain(token);
  expect(JSON.stringify(credentialReviewPlan(plan))).not.toContain(secretPath);
  expect(JSON.stringify(credentialReviewPlan(plan))).not.toContain(plan.executable);
  const args = sandboxArguments({ path: "/workspace", cwd: "/workspace", bindings: [], masked: [], credentialExecutable: profile.executable }, config.sandbox, "test", request().sandbox);
  expect(JSON.stringify(args)).not.toContain(token); expect(args).not.toContain("--setenv SERVICE_TOKEN");
  const result = await executeWithCredentials(request(), plan, config);
  const output = JSON.stringify(result);
  expect(result.isError).not.toBe(true); expect(output).not.toContain(token); expect(output).not.toContain(Buffer.from(token).toString("base64")); expect(output).toContain("[REDACTED]");
  const detail = JSON.parse((result.content[0] as any).text.split("\n")[0]);
  expect(detail.cwd).toBe("/workspace"); expect(detail.project).toBe(false); expect(detail.hostTmp).toBe(false); expect(detail.priorTmp).toBe(false);
  expect(detail.envNames).toEqual(["HOME", "LANG", "PATH", "SERVICE_TOKEN"]);
  const nextRequest = request(["check"]);
  const next = await executeWithCredentials(nextRequest, await resolveCredentialPlan(nextRequest, config), config);
  expect(JSON.parse((next.content[0] as any).text.split("\n")[0]).priorTmp).toBe(false);
  const ordinary = await executeIsolated({ tool: "bash", arguments: { command: "test -z \"$SERVICE_TOKEN\" && test ! -e /tmp/credential-leftover" }, goal: "Check isolation", justification: "Verify secret scope expiry" }, await validateWorkspace(project, config.sandbox, credentialProtectedPaths(config)), config.sandbox);
  expect(ordinary.isError).not.toBe(true);
  expect(await readFile(secretPath, "utf8")).toBe(token);
});
nativeTest("changed binaries, unavailable secrets and insecure secret files never run", async () => {
  const plan = await resolveCredentialPlan(request(), config);
  await expect(executeWithCredentials(request(), { ...plan, executableSha256: "changed" }, config)).rejects.toThrow("changed after review");
  const missing = { ...plan, secrets: { SERVICE_TOKEN: { type: "file" as const, path: join(fixture, "missing-token") } } };
  await expect(executeWithCredentials(request(), missing, config)).rejects.toThrow("ENOENT");
  await chmod(secretPath, 0o644);
  await expect(executeWithCredentials(request(), plan, config)).rejects.toThrow("owner-only");
  await chmod(secretPath, 0o600);
  const alias = join(fixture, "alias"); await symlink(secretPath, alias);
  await expect(executeWithCredentials(request(), { ...plan, secrets: { SERVICE_TOKEN: { type: "file", path: alias } } }, config)).rejects.toThrow();
});
nativeTest("nonzero status and cancellation are preserved without credential output", async () => {
  const failed = request(["fail"]);
  const result = await executeWithCredentials(failed, await resolveCredentialPlan(failed, config), config);
  expect(result.isError).toBe(true); expect(result.details.exitCode).toBe(7);
  const sleep = request(["sleep"]), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 200);
  try { await expect(executeWithCredentials(sleep, await resolveCredentialPlan(sleep, config), config, controller.signal)).rejects.toThrow("cancelled"); }
  finally { clearTimeout(timeout); }
  expect(JSON.stringify(await readdir(fixture))).not.toContain("credential-leftover");
});

nativeTest("real Linux gh resolves only synthetic credentials through its fixed offline getter", async () => {
  const action = { ...request(), arguments: { profile: "github", argv: ["pr", "view", "1", "--repo", "owner/repo"] } };
  const plan = await resolveCredentialPlan(action, config);
  const source = join(fixture, "synthetic-gh"), directory = join(fixture, "getter-job");
  await mkdir(source); await mkdir(directory);
  await writeFile(join(source, "hosts.yml"), `github.com:\n    oauth_token: ${token}\n    user: synthetic-test\n    git_protocol: https\n`, { mode: 0o600 });
  await writeFile(join(source, "unrelated-login"), "must not be copied", { mode: 0o600 });
  const executable = join(directory, "tool"); await copyFile(plan.executable, executable); await chmod(executable, 0o500);
  const previous = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]; delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
  try {
    const value = await resolveGithubCredential({ ...plan, configDirectory: source }, { path: "/workspace", cwd: "/workspace", bindings: [], masked: [], credentialExecutable: executable }, config, directory);
    expect(value).toBe(token);
    expect(await readdir(join(directory, "gh"))).toContain("hosts.yml");
    expect(await readdir(join(directory, "gh"))).not.toContain("unrelated-login");
    expect(await readFile(join(source, "hosts.yml"), "utf8")).toContain(token);
  } finally {
    for (const [i, name] of ["GH_TOKEN", "GITHUB_TOKEN"].entries()) { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }
  }
});

nativeTest("a general credential profile authenticates exactly its reviewed foreground service operation", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ operation: "close", number: "42" });
    return new Response("closed synthetic item 42");
  } });
  try {
    const serviceProfile: CredentialProfile = { ...profile, allowedArgv: [[{ literal: "service" }, { literal: "42" }]], environment: { SERVICE_URL: server.url.href } };
    const serviceConfig = { ...config, credentialProfiles: [serviceProfile] }, action = request(["service", "42"]);
    const result = await executeWithCredentials(action, await resolveCredentialPlan(action, serviceConfig), serviceConfig);
    expect(result.isError).not.toBe(true); expect(JSON.stringify(result)).toContain("closed synthetic item 42");
    expect(JSON.stringify(result)).not.toContain(token); expect(calls).toBe(1);
  } finally { server.stop(true); }
});

nativeTest("selected host environment secrets are redacted across split Unicode output, without inheriting other variables", async () => {
  const name = "PI_CREDENTIAL_SYNTHETIC_FIXTURE", previous = process.env[name];
  const synthetic = "ä-synthetic-unicode-password-雪";
  const envConfig = { ...config, credentialProfiles: [{ ...profile, secrets: { SERVICE_TOKEN: { type: "environment" as const, name } } }] };
  try {
    delete process.env[name];
    const plan = await resolveCredentialPlan(request(), envConfig);
    expect(JSON.stringify(credentialReviewPlan(plan))).not.toContain(name);
    await expect(executeWithCredentials(request(), plan, envConfig)).rejects.toThrow("Credential unavailable");
    process.env[name] = synthetic;
    const result = await executeWithCredentials(request(), plan, envConfig);
    const output = (result.content[0] as any).text as string;
    expect(output).not.toContain(synthetic); expect(output).not.toContain("synthetic-unicode-password");
    expect(output.trim().split("\n").slice(1)).toEqual(["[REDACTED]", "[REDACTED]"]);
    const detail = JSON.parse(output.split("\n")[0]);
    expect(detail.envNames).not.toContain(name);
  } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});
