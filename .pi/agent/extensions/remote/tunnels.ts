import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RemoteTarget } from "../shared/contracts/remote.ts";
import { hostname } from "./target.ts";
import { killSsh, sshProcess } from "./ssh.ts";

export type TunnelSpec = {
  direction: "local" | "remote";
  port: number;
  destinationHost: string;
  destinationPort: number;
  lifetimeSeconds?: number;
};

type Tunnel = {
  id: string;
  actor: string;
  spec: TunnelSpec;
  child: ChildProcessWithoutNullStreams;
  expires: number;
  state: string;
  stop(): void;
};

export function forwarding(spec: TunnelSpec) {
  if (
    !["local", "remote"].includes(spec.direction) ||
    !Number.isInteger(spec.port) ||
    spec.port < 1024 ||
    spec.port > 65535 ||
    !Number.isInteger(spec.destinationPort) ||
    spec.destinationPort < 1 ||
    spec.destinationPort > 65535 ||
    (spec.lifetimeSeconds !== undefined &&
      (!Number.isInteger(spec.lifetimeSeconds) ||
        spec.lifetimeSeconds < 10 ||
        spec.lifetimeSeconds > 82800))
  )
    throw new Error("Invalid tunnel direction, TCP port or lifetime");

  hostname(spec.destinationHost);

  const host =
    isIP(spec.destinationHost) === 6 ? `[${spec.destinationHost}]` : spec.destinationHost;

  return [
    spec.direction === "local" ? "-L" : "-R",
    `127.0.0.1:${spec.port}:${host}:${spec.destinationPort}`,
  ];
}

export class Tunnels {
  private jobs = new Map<string, Tunnel>();

  constructor(private connect = sshProcess) {}

  list(actor?: string) {
    return [...this.jobs.values()]
      .filter((job) => !actor || job.actor === actor)
      .map(({ id, spec, expires, state }) => ({
        id,
        ...spec,
        bindAddress: "127.0.0.1",
        expires,
        state,
      }));
  }

  async open(
    target: RemoteTarget,
    spec: TunnelSpec,
    actor: string,
    signal?: AbortSignal,
    startupTimeoutMs = 15000,
  ) {
    for (const job of [...this.jobs.values()]) if (job.state === "closed") this.jobs.delete(job.id);

    if (this.jobs.size >= 32) throw new Error("Close existing tunnels before opening more");

    signal?.throwIfAborted();

    const child = await this.connect(
      target,
      [
        "-M",
        "-S",
        "/tmp/pi-master",
        "-f",
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ClearAllForwardings=no",
        ...forwarding(spec),
      ],
      undefined,
      true,
    );
    const id = randomUUID();
    let diagnostic = "",
      timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      job.state = "closed";
      clearTimeout(timer);
      killSsh(child);
    };
    const abort = () => stop();
    const job: Tunnel = {
      id,
      actor,
      spec,
      child,
      expires: Date.now() + (spec.lifetimeSeconds ?? 3600) * 1000,
      state: "opening",
      stop,
    };

    this.jobs.set(id, job);
    timer = setTimeout(stop, job.expires - Date.now());
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostic.length < 1000)
        diagnostic += chunk.toString().slice(0, 1000 - diagnostic.length);
    });
    child.once("close", () => {
      job.state = "closed";
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
    child.once("error", () => {
      job.state = "closed";
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });

    try {
      signal?.throwIfAborted();

      await new Promise<void>((resolve, reject) => {
        let reply = "";
        const timeout = setTimeout(() => {
          stop();
          reject(new Error("SSH forwarding setup timed out"));
        }, startupTimeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          reply += chunk.toString();

          if (reply === "PI_SSH_FORWARD_READY\n") {
            clearTimeout(timeout);
            resolve();
          } else if (!"PI_SSH_FORWARD_READY\n".startsWith(reply)) {
            clearTimeout(timeout);
            stop();
            reject(new Error("Invalid SSH forwarding readiness reply"));
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("close", () => {
          clearTimeout(timeout);
          reject(new Error(`SSH forwarding closed: ${JSON.stringify(diagnostic.slice(0, 500))}`));
        });
      });
      signal?.throwIfAborted();
      job.state = "open";

      return this.list(actor).find((item) => item.id === id)!;
    } catch (error) {
      stop();
      this.jobs.delete(id);

      throw error;
    }
  }

  close(id: string, actor?: string) {
    const job = this.jobs.get(id);

    if (!job || (actor && actor !== job.actor)) throw new Error("Unknown tunnel for this actor");

    job.stop();
    job.state = "closed";
    this.jobs.delete(id);
  }

  closeAll(actor?: string) {
    for (const job of [...this.jobs.values()])
      if (!actor || actor === job.actor) this.close(job.id);
  }
}
