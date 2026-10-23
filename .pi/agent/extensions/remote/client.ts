import { workerSource } from "./source.ts";

import type { RemoteTarget } from "../shared/contracts/remote.ts";
import { sshProcess, killSsh } from "./ssh.ts";

/** Login shells disagree about backslashes inside quotes; only Base64 crosses that boundary. */
export function workerCommand(source: string) {
  const launcher = [
    "import base64,sys",
    "code=base64.b64decode(sys.argv[1]).decode()",
    "sys.argv[1]=code",
    'exec(compile(code,"<pi-remote>","exec"))',
  ].join("; ");

  return `python3 -I -B -c '${launcher}' ${Buffer.from(source).toString("base64")}`;
}

/** No command replay: a broken SSH transport may have executed an operation already. */
export async function remoteCall(
  target: RemoteTarget,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 30000,
  outputBytes = 1048576,
) {
  signal?.throwIfAborted();

  const encoded = JSON.stringify(input);

  if (Buffer.byteLength(encoded) > 1048576)
    throw new Error("Remote request exceeds 1 MiB; split the operation before review");

  const source = await workerSource;
  const child = await sshProcess(target, ["-o", "ClearAllForwardings=yes"], workerCommand(source));
  let stdout = Buffer.alloc(0),
    stderr = "",
    failure: Error | undefined;
  const abort = () => {
    failure = new Error("Remote operation interrupted; its outcome may be unknown");
    killSsh(child);
  };
  const timer = setTimeout(() => {
    failure = new Error("Remote SSH deadline exceeded; inspect remote state before retrying");
    killSsh(child);
  }, timeoutMs);

  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.length + chunk.length > outputBytes * 6 + 65536) {
      failure = new Error("Remote reply exceeds its output bound");
      killSsh(child);
    } else stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    if (signal?.aborted) abort();
    else child.stdin.end(encoded);

    const code = await exited;

    if (failure) throw failure;

    if (code !== 0)
      throw new Error(
        `SSH failed (${code}); no automatic replay. ${JSON.stringify(stderr.trim().slice(-900))}`,
      );

    const result = JSON.parse(stdout.toString("utf8"));

    if (result?.protocol !== "pi-remote-v1")
      throw new Error("Invalid remote reply; treat its outcome as unknown");

    if (result.error)
      throw new Error(`Remote worker: ${JSON.stringify(String(result.error).slice(0, 1000))}`);

    return result.value;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);

    if (child.exitCode === null) killSsh(child);
  }
}
