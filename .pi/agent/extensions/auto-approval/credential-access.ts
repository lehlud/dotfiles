import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { nativeLinuxNode } from "./local-tools.ts";
import { executeIsolated, type Workspace } from "./isolation.ts";
import { removeSessionTemporaryDirectory } from "./temporary-storage.ts";
import type { Config, Request } from "./policy.ts";
import type { CredentialExecution, CredentialProfile } from "./credential-command.ts";

export type CredentialPlan = { profile: string; executable: string; executableSha256: string; argv: string[]; environment: Record<string, string>; secrets: CredentialProfile["secrets"]; github?: true; configDirectory?: string };
const ghConfigDirectory = () => process.env.GH_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");
export function credentialProtectedPaths(config: Config): string[] {
  return [ghConfigDirectory(), ...(config.credentialProfiles ?? []).flatMap((profile) => [profile.executable, ...Object.values(profile.secrets).flatMap((source) => source.type === "file" ? [source.path] : [])])];
}

/** Vollständige Argumentfolgen prüfen; kein Regex-Teiltreffer gewährt Zugriff. */
export function matchesCredentialArgv(profile: CredentialProfile, argv: string[]): boolean {
  return profile.allowedArgv.some((rule) => rule.length === argv.length && rule.every((item, index) => {
    if ("literal" in item) return item.literal === argv[index];
    const match = new RegExp(`^(?:${item.pattern})$`, "u").exec(argv[index]);
    return match?.[0] === argv[index];
  }));
}

/** GitHub-Ziel explizit; keine Aliases, URLs, Plugins, Editoren oder lokalen Git-Aktionen. */
export function validateGithubArgv(argv: string[]): void {
  const [entity, operation, number, ...flags] = argv;
  if (!["pr", "issue"].includes(entity) || !["view", "close", "reopen", "comment"].includes(operation) || !/^[1-9][0-9]{0,9}$/.test(number ?? "")) throw new Error("github supports pr/issue view, close, reopen or comment with a numeric number and --repo OWNER/REPO");
  let repo = false, body = false;
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const key = ({ "-R": "--repo", "-b": "--body", "-c": operation === "view" ? "--comments" : "--comment" } as Record<string, string>)[flag] ?? flag;
    if (seen.has(key)) throw new Error("Repeated GitHub flags are not supported");
    seen.add(key);
    if (key === "--comments" && operation === "view") continue;
    if (!["--repo", ...(operation === "view" ? ["--json"] : []), ...(operation === "comment" ? ["--body"] : []), ...(["close", "reopen"].includes(operation) ? ["--comment"] : []), ...(entity === "issue" && operation === "close" ? ["--reason"] : [])].includes(key)) throw new Error(`Unsupported GitHub flag: ${flag}`);
    const value = flags[++i];
    if (value === undefined || value.includes("\0")) throw new Error("Missing GitHub flag value");
    if (key === "--repo") {
      if (!/^(?:github\.com\/)?[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_.-]+$/.test(value) || value.endsWith("/..") || value.endsWith("/.")) throw new Error("GitHub repository must be github.com/OWNER/REPO or OWNER/REPO");
      repo = true;
    }
    if (key === "--reason" && !["completed", "not planned"].includes(value)) throw new Error("Invalid issue close reason");
    if (key === "--body") body = true;
  }
  if (!repo || (operation === "comment" && !body)) throw new Error("GitHub commands require --repo OWNER/REPO; comment also requires --body");
}

async function executableBytes(path: string): Promise<Buffer> {
  if (!await nativeLinuxNode(path)) throw new Error("Credential profiles require a native Linux ELF executable, not a shell, macOS wrapper or symlink");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 128 * 1024 * 1024 || info.nlink !== 1) throw new Error("Unsafe credential executable");
    return await file.readFile();
  } finally { await file.close(); }
}
async function githubExecutable(): Promise<string> {
  for (const candidate of ["/usr/bin/gh", "/usr/sbin/gh", "/usr/local/bin/gh"]) {
    try {
      const path = await realpath(candidate), info = await lstat(path);
      if (info.uid === 0 && !(info.mode & 0o022) && await nativeLinuxNode(path)) return path;
    } catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  throw new Error("No trusted native Linux gh installation found; install gh inside Lubox outside Pi");
}
export async function resolveCredentialPlan(request: Request, config: Config): Promise<CredentialPlan> {
  if (config.sandbox.backend !== "bwrap") throw new Error("Credential execution currently requires native Linux bwrap; no host fallback");
  if (request.sandbox?.network !== "host") throw new Error("Credential commands require an explicit network: true request");
  if (request.sandbox && Object.keys(request.sandbox).some((key) => !["network", "limits"].includes(key))) throw new Error("Credential commands cannot grant mounts, local tools, search paths or agent-controlled environment");
  const profileName = request.arguments.profile as string, argv = request.arguments.argv as string[];
  const profile = config.credentialProfiles?.find((item) => item.name === profileName);
  let plan: Omit<CredentialPlan, "executableSha256">;
  if (profile) {
    if (!matchesCredentialArgv(profile, argv)) throw new Error("Arguments are outside the operator-configured credential profile");
    plan = { profile: profileName, executable: profile.executable, argv, environment: profile.environment ?? {}, secrets: profile.secrets };
  } else if (profileName === "github") {
    validateGithubArgv(argv);
    plan = { profile: "github", executable: await githubExecutable(), argv, environment: { GH_HOST: "github.com", GH_CONFIG_DIR: "/tmp/home/gh", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }, secrets: {}, github: true, configDirectory: ghConfigDirectory() };
  } else throw new Error("Unknown credential profile; the operator must configure credentialProfiles in auto-approval.device.json outside Pi");
  return { ...plan, executableSha256: createHash("sha256").update(await executableBytes(plan.executable)).digest("hex") };
}
export function credentialReviewPlan(plan: CredentialPlan) {
  return { profile: plan.profile, program: plan.github ? "gh" : basename(plan.executable), executableSha256: plan.executableSha256, argv: plan.argv, environment: plan.environment, credentialSources: Object.entries(plan.secrets).map(([variable, source]) => ({ variable, sourceType: source.type })), operatorArgumentMatch: true, githubCredentialSource: plan.github ? "Existing GitHub login: Pi token environment or fixed offline getter using a disposable private configuration copy; migration writes affect only that copy" : undefined, lifetime: "one reviewed argv-only process", projectFiles: false, sharedTemporaryFiles: false, secretTransport: "private executor stdin; never argv, audit or model context", privateSourceLocations: "Withheld; operator-owned and protected by workspace validation" };
}

async function readSecretFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 16384 || info.uid !== process.getuid?.()) throw new Error("Credential file must be owner-only, regular, without hardlinks, and at most 16 KiB");
    return (await file.readFile("utf8")).trimEnd();
  } finally { await file.close(); }
}
async function copyGithubConfiguration(source: string, target: string): Promise<void> {
  await mkdir(target, { mode: 0o700 });
  for (const name of ["hosts.yml", "config.yml"]) {
    let file;
    try {
      file = await open(join(source, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw new Error("Unsafe GitHub configuration file");
      await writeFile(join(target, name), await file.readFile(), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { await file?.close(); }
  }
}
const safeSecret = (secret: string | undefined): string => {
  if (!secret || secret.includes("\0") || secret.length > 16384) throw new Error("Credential unavailable or invalid; authenticate outside Pi");
  return secret;
};

/** Der feste Offline-Getter liefert nur dem vertrauenswürdigen Gate einen Token. */
export async function resolveGithubCredential(plan: CredentialPlan, workspace: Workspace, config: Config, directory: string, signal?: AbortSignal): Promise<string> {
  const inherited = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (inherited) return safeSecret(inherited);
  const source = join(directory, "gh");
  await copyGithubConfiguration(plan.configDirectory!, source);
  const getter: CredentialExecution = { executable: "/opt/pi-credential/tool", argv: ["auth", "token", "--hostname", "github.com"], environment: { GH_CONFIG_DIR: source, GH_PROMPT_DISABLED: "1" }, redact: [], maxOutputBytes: 32768 };
  const request: Request = { tool: "credential_exec", arguments: { profile: "github", argv: getter.argv }, goal: "Resolve approved GitHub credential", justification: "Fixed offline credential getter", sandbox: { network: "none", limits: { executionTimeoutMs: 10000, maxOutputBytes: 65536 } } };
  // gh migriert ältere Konfigurationen auch bei auth token. Nur die private Kopie ist schreibbar.
  const result = await executeIsolated(request, { ...workspace, bindings: [source], readOnlyBindings: [] }, config.sandbox, signal, getter);
  if (result.isError) throw new Error("GitHub credentials unavailable; authenticate gh inside Lubox outside Pi or supply GH_TOKEN to the Pi process. macOS Keychain-only logins are not available inside Linux");
  return safeSecret(result.content.filter((item) => item.type === "text").map((item) => item.text).join("").trim());
}

/** Auflösung erst nach protokollierter Freigabe; kein Secret landet im Request. */
export async function executeWithCredentials(request: Request, plan: CredentialPlan, config: Config, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bytes = await executableBytes(plan.executable);
  if (createHash("sha256").update(bytes).digest("hex") !== plan.executableSha256) throw new Error("Credential executable changed after review; submit a new action");
  const directory = await mkdtemp(join(tmpdir(), "pi-credential-command-"));
  const executable = join(directory, "tool");
  const workspace: Workspace = { path: "/workspace", cwd: "/workspace", bindings: [], masked: [], credentialExecutable: executable };
  try {
    await writeFile(executable, bytes, { mode: 0o500, flag: "wx" });
    const environment = { ...plan.environment }, secrets: string[] = [];
    for (const [name, source] of Object.entries(plan.secrets)) {
      const value = safeSecret(source.type === "environment" ? process.env[source.name] : await readSecretFile(source.path));
      environment[name] = value; secrets.push(value);
    }
    if (plan.github) {
      environment.GH_TOKEN = await resolveGithubCredential(plan, workspace, config, directory, signal);
      secrets.push(environment.GH_TOKEN);
    }
    signal?.throwIfAborted();
    const execution: CredentialExecution = { executable: "/opt/pi-credential/tool", argv: plan.argv, environment, redact: secrets, maxOutputBytes: request.sandbox?.limits?.maxOutputBytes ?? 16 * 1024 * 1024 };
    return await executeIsolated(request, workspace, config.sandbox, signal, execution);
  } catch (error) {
    // Secret-Dateiinhalte und Getter-Ausgabe erscheinen auch bei Fehlern nie im Audit.
    if (signal?.aborted) throw new Error("Credential execution cancelled");
    throw new Error(error instanceof Error ? error.message : "Credential execution failed");
  } finally { await removeSessionTemporaryDirectory(directory); }
}
