import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { nativeLinuxNode } from "./local-tools.ts";
import { executeIsolated, type Workspace } from "./isolation.ts";
import { removeSessionTemporaryDirectory } from "../shared/session/temporary-storage.ts";
import type { Config } from "../shared/configuration/schemas.ts";
import type { Request } from "../shared/contracts/action.ts";
import type { CredentialExecution, CredentialProfile } from "./credential-command.ts";

export type CredentialPlan = {
  profile: string;
  executable: string;
  executableSha256: string;
  argv: string[];
  argumentPolicy: "review" | "allowlist";
  environment: Record<string, string>;
  secrets: CredentialProfile["secrets"];
  github?: true;
  configDirectory?: string;
};

const ghConfigDirectory = () =>
  process.env.GH_CONFIG_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");

export function credentialProtectedPaths(config: Config): string[] {
  return [
    ghConfigDirectory(),
    ...(config.credentialProfiles ?? []).flatMap((profile) => [
      profile.executable,
      ...Object.values(profile.secrets).flatMap((source) =>
        source.type === "file" ? [source.path] : [],
      ),
    ]),
  ];
}

/** Check complete argument sequences; partial regex matches never grant access. */
export function matchesCredentialArgv(profile: CredentialProfile, argv: string[]): boolean {
  if ("argumentPolicy" in profile) return profile.argumentPolicy === "review";

  return profile.allowedArgv.some(
    (rule) =>
      rule.length === argv.length &&
      rule.every((item, index) => {
        if ("literal" in item) return item.literal === argv[index];

        const match = new RegExp(`^(?:${item.pattern})$`, "u").exec(argv[index]);

        return match?.[0] === argv[index];
      }),

  );
}

async function executableBytes(path: string): Promise<Buffer> {
  if (!(await nativeLinuxNode(path)))
    throw new Error(
      "Credential profiles require a native Linux ELF executable, not a shell, macOS wrapper or symlink",
    );

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const info = await file.stat();

    if (!info.isFile() || info.size > 128 * 1024 * 1024 || info.nlink !== 1)
      throw new Error("Unsafe credential executable");

    return await file.readFile();
  } finally {
    await file.close();
  }

}

async function githubExecutable(): Promise<string> {
  for (const candidate of ["/usr/bin/gh", "/usr/sbin/gh", "/usr/local/bin/gh"]) {
    try {
      const path = await realpath(candidate),
        info = await lstat(path);

      if (info.uid === 0 && !(info.mode & 0o022) && (await nativeLinuxNode(path))) return path;

    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;

    }

  }

  throw new Error(
    "No trusted native Linux gh installation found; install gh inside Lubox outside Pi",
  );
}

export async function resolveCredentialPlan(
  request: Request,
  config: Config,
): Promise<CredentialPlan> {
  if (config.sandbox.backend !== "bwrap")
    throw new Error("Credential execution currently requires native Linux bwrap; no host fallback");

  if (
    request.sandbox &&
    Object.keys(request.sandbox).some(
      (key) => !["network", "limits", "paths", "projectFiles"].includes(key),
    )
  )
    throw new Error(
      "Credential commands cannot grant local tools, search paths or agent-controlled environment",
    );

  const profileName = request.arguments.profile as string,
    argv = request.arguments.argv as string[];
  const profile = config.credentialProfiles?.find((item) => item.name === profileName);
  let plan: Omit<CredentialPlan, "executableSha256">;

  if (profile) {
    if (!matchesCredentialArgv(profile, argv))
      throw new Error("Arguments are outside the operator-configured credential profile");

    plan = {
      profile: profileName,
      executable: profile.executable,
      argv,
      argumentPolicy: "argumentPolicy" in profile ? "review" : "allowlist",
      environment: profile.environment ?? {},
      secrets: profile.secrets,
    };
  } else if (profileName === "github") {
    plan = {
      profile: "github",
      executable: await githubExecutable(),
      argv,
      argumentPolicy: "review",
      environment: {
        GH_HOST: "github.com",
        GH_CONFIG_DIR: "/tmp/home/gh",
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "cat",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
      },
      secrets: {},
      github: true,
      configDirectory: ghConfigDirectory(),
    };
  } else
    throw new Error(
      "Unknown credential profile; the operator must configure credentialProfiles in auto-approval.device.json outside Pi",
    );

  return {
    ...plan,
    executableSha256: createHash("sha256")
      .update(await executableBytes(plan.executable))
      .digest("hex"),
  };
}

export function credentialReviewPlan(plan: CredentialPlan, fileAccess = false) {
  return {
    profile: plan.profile,
    program: plan.github ? "gh" : basename(plan.executable),
    executableSha256: plan.executableSha256,
    argv: plan.argv,
    environment: plan.environment,
    credentialSources: Object.entries(plan.secrets).map(([variable, source]) => ({
      variable,
      sourceType: source.type,
    })),
    argumentPolicy: plan.argumentPolicy,
    operatorArgumentMatch: plan.argumentPolicy === "allowlist" ? true : undefined,
    argumentAuthorization:
      "The profile binds a program and login, not user authorization. Independently decide on this complete argv, service effects and all requested accesses.",
    githubCredentialSource: plan.github
      ? "Existing GitHub login: Pi token environment or fixed offline getter using a disposable private configuration copy; migration writes affect only that copy"
      : undefined,
    lifetime: "one reviewed argv-only process",
    projectFiles: fileAccess,
    sharedTemporaryFiles: false,
    secretTransport: "private executor stdin; never argv, audit or model context",
    privateSourceLocations: "Withheld; operator-owned and protected by workspace validation",
  };
}

async function readSecretFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const info = await file.stat();

    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.size > 16384 ||
      info.uid !== process.getuid?.()
    )
      throw new Error(
        "Credential file must be owner-only, regular, without hardlinks, and at most 16 KiB",
      );

    return (await file.readFile("utf8")).trimEnd();
  } finally {
    await file.close();
  }

}

async function copyGithubConfiguration(source: string, target: string): Promise<void> {
  await mkdir(target, { mode: 0o700 });

  for (const name of ["hosts.yml", "config.yml"]) {
    let file;

    try {
      file = await open(
        join(source, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );

      const info = await file.stat();

      if (!info.isFile() || info.nlink !== 1 || info.size > 65536)
        throw new Error("Unsafe GitHub configuration file");

      await writeFile(join(target, name), await file.readFile(), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    } finally {
      await file?.close();
    }

  }

}

const safeSecret = (secret: string | undefined): string => {
  if (!secret || secret.includes("\0") || secret.length > 16384)
    throw new Error("Credential unavailable or invalid; authenticate outside Pi");

  return secret;
};

/** The fixed offline getter supplies a token only to the trusted gate. */
export async function resolveGithubCredential(
  plan: CredentialPlan,
  workspace: Workspace,
  config: Config,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const inherited = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

  if (inherited) return safeSecret(inherited);

  const source = join(directory, "gh");

  await copyGithubConfiguration(plan.configDirectory!, source);

  const getter: CredentialExecution = {
    executable: "/opt/pi-credential/tool",
    argv: ["auth", "token", "--hostname", "github.com"],
    environment: { GH_CONFIG_DIR: source, GH_PROMPT_DISABLED: "1" },
    redact: [],
    maxOutputBytes: 32768,
  };
  const request: Request = {
    tool: "credential_exec",
    arguments: { profile: "github", argv: getter.argv },
    goal: "Resolve approved GitHub credential",
    justification: "Fixed offline credential getter",
    sandbox: { network: "none", limits: { executionTimeoutMs: 10000, maxOutputBytes: 65536 } },
  };
  // gh migrates older configurations even during auth token. Only the private copy is writable.
  const result = await executeIsolated(
    request,
    {
      path: "/workspace",
      cwd: "/workspace",
      bindings: [source],
      masked: [],
      credentialExecutable: workspace.credentialExecutable,
    },
    config.sandbox,
    signal,
    getter,
  );

  if (result.isError)
    throw new Error(
      "GitHub credentials unavailable; authenticate gh inside Lubox outside Pi or supply GH_TOKEN to the Pi process. macOS Keychain-only logins are not available inside Linux",
    );

  return safeSecret(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("")
      .trim(),
  );
}

/** Resolve credentials only after recorded approval; secrets never enter the request. */
export async function executeWithCredentials(
  request: Request,
  plan: CredentialPlan,
  config: Config,
  signal?: AbortSignal,
  approvedWorkspace?: Workspace,
) {
  signal?.throwIfAborted();

  const bytes = await executableBytes(plan.executable);

  if (createHash("sha256").update(bytes).digest("hex") !== plan.executableSha256)
    throw new Error("Credential executable changed after review; submit a new action");

  const directory = await mkdtemp(join(tmpdir(), "pi-credential-command-"));
  const executable = join(directory, "tool");
  const workspace: Workspace = approvedWorkspace
    ? { ...approvedWorkspace, temporaryDirectory: undefined, credentialExecutable: executable }
    : {
        path: "/workspace",
        cwd: "/workspace",
        bindings: [],
        masked: [],
        credentialExecutable: executable,
      };

  try {
    await writeFile(executable, bytes, { mode: 0o500, flag: "wx" });

    const environment = { ...plan.environment },
      secrets: string[] = [];

    for (const [name, source] of Object.entries(plan.secrets)) {
      const value = safeSecret(
        source.type === "environment"
          ? process.env[source.name]
          : await readSecretFile(source.path),
      );

      environment[name] = value;
      secrets.push(value);
    }

    if (plan.github) {
      environment.GH_TOKEN = await resolveGithubCredential(
        plan,
        workspace,
        config,
        directory,
        signal,
      );
      secrets.push(environment.GH_TOKEN);
    }

    signal?.throwIfAborted();

    const execution: CredentialExecution = {
      executable: "/opt/pi-credential/tool",
      argv: plan.argv,
      environment,
      redact: secrets,
      maxOutputBytes: request.sandbox?.limits?.maxOutputBytes ?? 16 * 1024 * 1024,
    };

    return await executeIsolated(request, workspace, config.sandbox, signal, execution);
  } catch (error) {
    // Secret file contents and getter output never enter the audit, including on failure.
    if (signal?.aborted) throw new Error("Credential execution cancelled");

    throw new Error(error instanceof Error ? error.message : "Credential execution failed");
  } finally {
    await removeSessionTemporaryDirectory(directory);
  }

}

