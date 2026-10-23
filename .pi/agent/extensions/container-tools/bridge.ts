import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const privateRoot = join(homedir(), ".local/cache/pi-container-tools");
export const helperRoot = join(homedir(), ".local/share/lubox/engine_jobs");
export const launcher = join(homedir(), ".local/bin/lubox");

export async function sourceIdentity() {
  const paths = [
    launcher,
    ...Array.from(new Bun.Glob("*.py").scanSync(helperRoot))
      .sort()
      .map((name) => join(helperRoot, name)),
  ];

  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
}

export async function discoverBridge() {
  if (process.platform !== "linux" || !Bun.which("bwrap"))
    throw new Error("Container jobs need the existing Linux bwrap transport inside Lubox");

  const container = process.env.LUBOX_CONTAINER_NAME;

  if (!container || process.env.LUBOX_HOST_EXEC === "0")
    throw new Error(
      "Container jobs need Lubox's existing host bridge; no engine socket is exposed to agent shells",
    );

  const configPath = process.env.LUBOX_HOSTEXEC_CONFIG ?? "/run/lubox/hostexec.json";
  const config = JSON.parse(await readFile(configPath, "utf8"));

  if (!config.enabled || typeof config.token_path !== "string" || !config.container_id)
    throw new Error("Lubox host bridge is disabled or incomplete");

  const token = await realpath(config.token_path);

  if (!(await stat(token)).isFile()) throw new Error("Invalid Lubox bridge credential source");

  await access(launcher);

  return { container, config, token, sources: await sourceIdentity() };
}

/** Only this fixed client can reach the private bridge credential; project code is never mounted. */
export async function bridgeCall(
  bridge: Awaited<ReturnType<typeof discoverBridge>>,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 15000,
  outputBytes = 1048576,
) {
  signal?.throwIfAborted();

  const raw = JSON.stringify({ ...input, sources: bridge.sources });

  if (Buffer.byteLength(raw) > 1048576)
    throw new Error("Container job exceeds its 1 MiB input bound");

  const { mkdir } = await import("node:fs/promises");

  await mkdir(privateRoot, { recursive: true, mode: 0o700 });

  const temporary = await mkdtemp(join(privateRoot, "bridge-"));
  const configPath = join(temporary, "config.json");

  await writeFile(configPath, JSON.stringify({ ...bridge.config, token_path: "/bridge/token" }), {
    mode: 0o400,
  });

  const args = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    ...[
      "/etc/ld.so.cache",
      "/etc/passwd",
      "/etc/group",
      "/etc/resolv.conf",
      "/etc/hosts",
      "/etc/nsswitch.conf",
    ].flatMap((path) => ["--ro-bind-try", path, path]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--ro-bind",
    launcher,
    launcher,
    "--ro-bind",
    configPath,
    "/bridge/config.json",
    "--ro-bind",
    bridge.token,
    "/bridge/token",
    "--clearenv",
    ...Object.entries({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      LANG: "C.UTF-8",
      LUBOX_CONTAINER_NAME: bridge.container,
      LUBOX_HOST_EXEC: "1",
      LUBOX_HOSTEXEC_CONFIG: "/bridge/config.json",
    }).flatMap(([name, value]) => ["--setenv", name, value]),
    "/usr/bin/python3",
    "-I",
    "-B",
    launcher,
    "host-exec",
    "/usr/bin/env",
    "-i",
    "PATH=/opt/homebrew/bin:/opt/podman/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "/usr/bin/python3",
    "-I",
    "-B",
    launcher,
    "__pi-engine",
  ];
  const child = spawn(Bun.which("bwrap")!, args, {
    stdio: "pipe",
    detached: true,
    env: { PATH: "/usr/bin:/bin" },
  });
  const kill = () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  let output = Buffer.alloc(0),
    diagnostic = "",
    failure: Error | undefined;
  const abort = () => {
    failure = new Error("Container job interrupted; inspect its outcome before retrying");
    kill();
  };
  const timeout = setTimeout(() => {
    failure = new Error("Container job transport deadline exceeded; no automatic replay");
    kill();
  }, timeoutMs);

  signal?.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    if (output.length + chunk.length > outputBytes * 6 + 65536) {
      failure = new Error("Container job output limit exceeded");
      kill();
    } else output = Buffer.concat([output, chunk]);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-2000);
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });

  if (signal?.aborted) abort();
  else child.stdin.end(raw);

  try {
    const code = await exited;

    if (failure) throw failure;

    let packet;

    try {
      packet = JSON.parse(output.toString());
    } catch {
      throw new Error(`Lubox engine bridge failed (${code}): ${JSON.stringify(diagnostic)}`);
    }

    if (packet.protocol !== "pi-engine-v1") throw new Error("Invalid engine bridge reply");

    if (packet.error) throw new Error(`Container job: ${JSON.stringify(String(packet.error))}`);

    if (code !== 0) throw new Error("Engine bridge exited unsuccessfully; no replay");

    return packet.value;
  } catch (error) {
    if (input.operation === "execute") {
      kill();

      try {
        await bridgeCall(bridge, { ...input, operation: "cancel" }, undefined, 60000, 4096);
      } catch {
        throw new Error(
          "Container job transport failed and owned-resource cleanup could not be confirmed; inspect the job before retrying",
        );
      }
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    kill();
    await rm(temporary, { recursive: true, force: true });
  }
}
