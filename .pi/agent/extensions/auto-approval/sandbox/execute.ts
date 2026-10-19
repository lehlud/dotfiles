import { StringDecoder } from "node:string_decoder";
import { BoundedOutput } from "./output.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Request } from "../../shared/contracts/action.ts";
import type { CredentialExecution } from "../credential-command.ts";
import type { GitConfigReader } from "../git-command.ts";
import { temporaryMountpoints, cleanTemporaryMountpoints } from "./temporary-mounts.ts";
import { sandboxArguments } from "./arguments.ts";
import type { SandboxConfig, Workspace } from "./types.ts";
import { createCgroupScope, type CgroupScope } from "./cgroup-scope.ts";
import { assertCgroupsHidden } from "./cgroup-boundary.ts";

/** Both backends are mandatory isolation. A launch failure never executes on the host. */
export async function executeIsolated(
  request: Request,
  workspace: Workspace,
  config: SandboxConfig,
  signal?: AbortSignal,
  credentialExecution?: CredentialExecution,
  gitConfigReader?: GitConfigReader,
): Promise<AgentToolResult<any>> {
  signal?.throwIfAborted();

  await assertCgroupsHidden(workspace);

  const scope = await createCgroupScope(config, workspace, request.sandbox);

  try {
    signal?.throwIfAborted();

    return await executeCommand(
      request,
      workspace,
      config,
      signal,
      credentialExecution,
      gitConfigReader,
      scope,
    );
  } catch (error) {
    if (scope && (await scope.memoryKilled()))
      throw new Error("Isolated action exceeded its aggregate cgroup memory limit", {
        cause: error,
      });

    throw error;
  } finally {
    await scope?.dispose();
  }
}

async function executeCommand(
  request: Request,
  workspace: Workspace,
  config: SandboxConfig,
  signal: AbortSignal | undefined,
  credentialExecution: CredentialExecution | undefined,
  gitConfigReader: GitConfigReader | undefined,
  scope: CgroupScope,
): Promise<AgentToolResult<any>> {
  const input = JSON.stringify({
    ...request,
    ...(credentialExecution ? { credentialExecution } : {}),
    ...(gitConfigReader ? { gitConfigReader } : {}),
  });

  if (Buffer.byteLength(input) > 100000) throw new Error("Executor input limit exceeded");

  const name = `pi-approved-${randomUUID()}`;
  const native = config.backend === "bwrap";
  const executable = native ? config.executable : config.dockerExecutable;
  // Bind mount scaffolding must not survive an action-specific access grant.
  const mountpoints = await temporaryMountpoints(workspace);
  const args = sandboxArguments(workspace, config, name, request.sandbox);
  const launch = scope?.launch(executable, args) ?? { executable, args };
  const child = spawn(launch.executable, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: native,
    ...(scope ? { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } } : {}),
  });
  const output = new BoundedOutput(request.sandbox?.limits?.maxOutputBytes ?? 16 * 1024 * 1024);
  const diagnosticDecoder = new StringDecoder("utf8");
  let stderr = "";
  let failure: Error | undefined;
  let cleanup: Promise<void> | undefined;
  const remove = () => {
    if (!cleanup)
      cleanup = native
        ? Promise.resolve().then(async () => {
            await scope?.kill();

            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              }
            }
          })
        : new Promise<void>((done) => {
            const rm = spawn(executable, ["rm", "--force", name], { stdio: "ignore" });

            rm.once("error", () => done());
            rm.once("close", () => done());
          });

    return cleanup;
  };

  const stop = (reason: string) => {
    failure ??= new Error(reason);
    void remove().catch(() => {});
    child.kill("SIGTERM");
  };

  const abort = () => stop("Isolated execution cancelled");

  signal?.addEventListener("abort", abort, { once: true });

  const watchdog = setTimeout(
    () => stop("Isolated executor exceeded the technical execution limit"),
    request.sandbox?.limits?.executionTimeoutMs ?? 600000,
  );

  try {
    const exited = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        output.append(chunk);
      } catch {
        stop("Executor output limit exceeded");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 20000) stderr += diagnosticDecoder.write(chunk);
    });

    child.stdin.on("error", () => {});

    if (signal?.aborted) abort();
    else child.stdin.end(input);

    const code = await exited;
    const stdout = output.finish();

    stderr += diagnosticDecoder.end();

    if (failure) throw failure;

    if (code !== 0)
      throw new Error(
        `Mandatory ${native ? "bwrap" : "Docker"} sandbox failed (${code}); no local fallback. ${stderr.trim()}`,
      );

    const result: unknown = JSON.parse(stdout);

    if (!result || typeof result !== "object" || !Array.isArray((result as any).content))
      throw new Error("Invalid executor result");

    return result as AgentToolResult<any>;
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", abort);
    await remove();
    await cleanTemporaryMountpoints(workspace.temporaryDirectory, mountpoints);
  }
}
