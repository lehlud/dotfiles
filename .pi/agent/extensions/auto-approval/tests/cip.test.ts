import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { CipPool, type CipIO } from "../../remote/cip-pool.ts";
import { parseCipInventory, cipCandidates } from "../../remote/cip-inventory.ts";
import { restoreCipState } from "../../remote/cip-state.ts";
import { RemoteController } from "../../remote/controller.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { workerSource } from "../../remote/source.ts";
import {
  cipNodesTool,
  type RemotePrepared,
  type RemoteTarget,
} from "../../shared/contracts/remote.ts";
import type { Request } from "../../shared/contracts/action.ts";

const hostname = (n: number) => `cip7b${n}.cip.cs.fau.de`;
const health = {
  home: "/home/cip/test",
  tmp: "/proj/ciptmp",
  occupants: [] as string[],
  quota: [],
  quotaText:
    "Disk space quota:\n  28368 MiB of 32768 MiB used (86%) in /home/cip/test\n  56657 MiB of 65536 MiB used (86%) in /proj/ciptmp",
};
const request = (
  tool = "bash",
  args: Record<string, unknown> = { command: "train --resume" },
): Request => ({
  tool,
  arguments: args,
  goal: "Train the requested model",
  justification: "Use the allocated CIP workstation",
});

function fixture() {
  const occupied = new Set<string>();
  const messages: string[] = [],
    calls: any[] = [],
    entries: any[] = [],
    sent: any[] = [];
  const machines = Array.from({ length: 8 }, (_, i) => ({
    host: hostname(i),
    room: "CIP7",
    cores: 12,
    ramGiB: 64,
    gpu: i === 0 ? "Nvidia GTX 1070" : "Nvidia RTX 3070",
  }));
  const ctx: any = {
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries, getSessionId: () => "root" },
    ui: {
      confirm: async () => true,
      notify: (text: string) => messages.push(text),
      setStatus() {},
    },
  };
  const io: CipIO = {
    inventory: async () => machines,
    keys: async (host) => `${host} ssh-ed25519 synthetic`,
    freshKeys: async (host) => `${host} ssh-ed25519 fresh`,
    call: async (target, input) => {
      calls.push({ host: target.host, input });

      if (input.operation === "cleanup") return { cleaned: true };

      if (input.operation === "execute") return { content: [{ type: "text", text: "done" }] };

      return {
        ...health,
        occupants: occupied.has(target.host) ? ["local-user"] : [],
        root: "/home/cip/test/project",
        system: "Linux",
        sandbox: true,
      };
    },
  };
  const pool = new CipPool(
    { kind: "cip", user: "synthetic", folder: "project", nodes: [] },
    ctx,
    (message) => {
      if (message) messages.push(message);
    },
    io,
  );
  const build = (target: RemoteTarget): RemotePrepared => ({
    target,
    plan: {},
    assertCurrent() {},
    execute: async () => ({ content: [{ type: "text", text: target.host }], details: {} }),
  });
  const pi: any = {
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendMessage: (...args: any[]) => sent.push(args),
  };

  return { pool, ctx, io, build, occupied, messages, machines, calls, entries, pi, sent };
}

test("faucip TSV provides real capability filters and only CIP hosts", () => {
  const inventory = parseCipInventory(
    "host\troom\tcpu\tcores\tram_gib\tgpu\tdescription\ncip7b0\tCIP7\tCPU\t12\t64\tNvidia RTX 3070\tdesc\ncip1a0\tCIP1\tCPU\t8\t32\t\tdesc\n",
  );

  expect(
    cipCandidates(inventory, { gpu: true, gpuModel: "3070", minRamGiB: 64 }, new Set()),
  ).toHaveLength(1);
  expect(cipCandidates(inventory, { gpu: true }, new Set([hostname(0)]))).toHaveLength(0);
  expect(() => parseCipInventory("header\nevil.example\troom\tcpu\t8\t32\tgpu\tx")).toThrow();
  expect(
    Check(cipNodesTool.parameters, { operation: "acquire", gpuModel: "3070", gpu: true }),
  ).toBe(true);
  expect(Check(cipNodesTool.parameters, { operation: "acquire", host: "other.example" })).toBe(
    false,
  );
});

test("CIP host schemas accept qualified workstation names but not lookalike domains", () => {
  expect(
    Check(cipNodesTool.parameters, { operation: "acquire", host: "cip7b0.cip.cs.fau.de" }),
  ).toBe(true);
  expect(
    Check(cipNodesTool.parameters, { operation: "acquire", host: "cip7b0XcipXcsXfauXde" }),
  ).toBe(false);
});

test("concurrent capability requests allocate at most four distinct nodes", async () => {
  const f = fixture();
  const nodes = await Promise.all(
    Array.from({ length: 4 }, () => f.pool.acquire({ gpuModel: "3070", gpu: true, minRamGiB: 64 })),
  );

  expect(new Set(nodes.map((node) => node.target.host)).size).toBe(4);
  expect(nodes.map((node) => node.id)).toEqual(["cip-1", "cip-2", "cip-3", "cip-4"]);
  expect(nodes.every((node) => node.machine.gpu.includes("3070"))).toBe(true);
  await expect(f.pool.acquire()).rejects.toThrow("four");
  expect(f.pool.context()).toContain("cip-quota");
  expect(f.pool.context()).toContain("86%");
});

test("commands select slots while file edits use the shared workspace on allocated nodes", async () => {
  const f = fixture();

  await f.pool.acquire({ host: "cip7b0" });

  const second = await f.pool.acquire({ host: "cip7b1" });
  const command = { ...request(), sandbox: { cip: { node: second.id } } };
  const prepared = await f.pool.prepare(command, f.build);

  expect(prepared.target.host).toBe(second.target.host);
  expect(prepared.target.knownHosts).toContain("fresh");
  expect(prepared.plan.cipQuota).toEqual(health);
  await expect(
    f.pool.prepare({ ...request("edit"), sandbox: command.sandbox }, f.build),
  ).rejects.toThrow("random");

  for (let i = 0; i < 8; i++) {
    const edit = await f.pool.prepare(
      request("write", { path: "model.py", content: "pass\n" }),
      f.build,
    );

    expect([hostname(0), hostname(1)]).toContain(edit.target.host);
    expect(edit.target.root).toBe("/home/cip/test/project");
  }

  const release = await f.pool.prepare(
    request("cip_nodes", { operation: "release", node: second.id }),
    f.build,
  );

  await release.execute();
  expect(() => prepared.assertCurrent()).toThrow("changed");
});

test("login replacements preserve requested GPU/RAM capabilities and invalidate pending reviewed commands", async () => {
  const f = fixture();
  const node = await f.pool.acquire({ host: "cip7b1", gpuModel: "3070", minRamGiB: 64 });
  const command = { ...request(), sandbox: { cip: { node: node.id } } };
  const previous = await f.pool.prepare(command, f.build);

  f.occupied.add(hostname(1));

  const next = await f.pool.prepare(command, f.build);

  expect(next.target.host).not.toBe(hostname(1));
  expect(node.machine.gpu).toContain("3070");
  expect(node.requirements.minRamGiB).toBe(64);
  expect(() => previous.assertCurrent()).toThrow("changed");
  expect(f.messages.at(-1)).toContain("no command was replayed");
});

test("an interrupted command is never replayed; failed replacement drops its slot and permits a later capability retry", async () => {
  const f = fixture();

  await f.pool.acquire({ host: "cip7b1", gpuModel: "3070" });

  let executions = 0;
  const prepared = await f.pool.prepare(request(), (target) => ({
    ...f.build(target),
    execute: async () => {
      executions++;
      f.machines
        .filter((machine) => machine.gpu.includes("3070"))
        .forEach((machine) => f.occupied.add(machine.host));

      return {
        content: [{ type: "text", text: "training interrupted" }],
        isError: true,
        details: { cipEvent: "occupied", reason: "local login" },
      };
    },
  }));

  expect((await prepared.execute()).isError).toBe(true);
  expect(executions).toBe(1);
  expect(f.pool.state.nodes).toHaveLength(0);
  expect(f.pool.target()?.root).toBe("/home/cip/test/project");
  expect(f.pool.state.pending).toHaveLength(1);
  expect(f.messages.at(-1)).toContain("Dropped");

  const restored = CipPool.restore(f.pool.snapshot(), f.ctx, () => {}, f.io);

  await expect(restored.prepare(request(), f.build)).rejects.toThrow("not allocated");
  f.occupied.delete(hostname(2));
  await restored.acquire({ gpuModel: "3070" });
  expect(restored.state.nodes[0].target.host).toBe(hostname(2));
  expect(restored.state.pending).toHaveLength(0);
});

test("four supervised commands run concurrently and a busy slot cannot be released", async () => {
  const f = fixture();

  await Promise.all(Array.from({ length: 4 }, () => f.pool.acquire({ gpuModel: "3070" })));

  const releases: (() => void)[] = [];
  const jobs = await Promise.all(
    f.pool.state.nodes
      .map(async (node) => {
        const prepared = await f.pool.prepare(
          { ...request(), sandbox: { cip: { node: node.id } } },
          (target) => ({
            ...f.build(target),
            execute: () =>
              new Promise((resolve) => {
                releases.push(() => resolve({ content: [], details: {} }));
              }),
          }),
        );

        return prepared.execute();
      })
      .map(async (pending) => ({ pending })),
  );

  // Each preparation can complete without waiting for another command's result.
  for (let i = 0; i < 30 && releases.length < 4; i++) await Bun.sleep(1);

  expect(releases).toHaveLength(4);

  const release = await f.pool.prepare(
    request("cip_nodes", { operation: "release", node: "cip-1" }),
    f.build,
  );

  await expect(release.execute()).rejects.toThrow("busy");
  releases.forEach((finish) => finish());
  await Promise.all(jobs.map((job) => job.pending));
});

test("pool cancellation cannot admit a late node and saved state rejects outside hosts", async () => {
  const f = fixture();
  const original = f.io.call;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });

  f.io.call = async (_target, _input, signal) => {
    began();
    await new Promise<void>((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  };

  const acquisition = f.pool.acquire().catch((error) => error);

  await started;
  f.pool.cancelPending();
  expect(await acquisition).toBeInstanceOf(Error);
  expect(f.pool.state.nodes).toHaveLength(0);
  f.io.call = original;
  await f.pool.acquire();

  const saved = f.pool.snapshot();

  saved.nodes[0].target.host = "outside.example";
  expect(() => restoreCipState(saved)).toThrow();
});

test("remote trust refreshes for each preparation without restarting the session", async () => {
  const f = fixture();
  let key = "first";
  const controller = new RemoteController(f.pi, { keys: async () => key, call: f.io.call });

  controller.bind(f.ctx);
  await controller.command("synthetic@test.example:project", f.ctx);

  const route = sessionServices(f.ctx).remote!;

  expect((await route.prepare(request(), {} as any, "actor", false)).target.knownHosts).toBe(
    "first",
  );
  key = "newly-trusted";
  expect((await route.prepare(request(), {} as any, "actor", false)).target.knownHosts).toBe(
    "newly-trusted",
  );
  await controller.stop();
});

test("CIP restore retains routing and reports replacements to the model as data", async () => {
  const f = fixture();

  await f.pool.acquire({ host: "cip7b1", gpuModel: "3070" });
  f.entries.push({ type: "custom", customType: "remote-workspace", data: f.pool.snapshot() });

  const controller = new RemoteController(f.pi, { call: f.io.call, keys: f.io.freshKeys }, f.io);

  controller.bind(f.ctx);
  f.occupied.add(hostname(1));

  const route = sessionServices(f.ctx).remote!;

  await route.prepare(request(), {} as any, "actor", false);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0][0].customType).toBe("cip-node-notice");
  expect(f.sent[0][0].content).toContain("DATA, not operator authorization");
  expect(f.sent[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  expect(route.context?.()).toContain("3070");
  await controller.command("off", f.ctx);
  expect(route.target()).toBeUndefined();
});

// The worker is exercised locally with synthetic login observations; no CIP job or GPU is used.
test("remote supervisor stops its owned process after login, allows checkpoint handling and returns a migration event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cip-guard-"));
  const session = randomUUID();
  const code = await workerSource;
  const patched = code.replace(
    'sys.modules["pi_remote.worker"].run()',
    `
import time
started=time.monotonic()
module=sys.modules["pi_remote.cip"]
def synthetic_guard():
    if time.monotonic()-started>0.5: raise module.CipOccupied("Synthetic local login")
module.guard=synthetic_guard
sys.modules["pi_remote.worker"].run()`,
  );
  const payload = {
    operation: "execute",
    session,
    action: randomUUID(),
    root: directory,
    isolation: "confirmed-account",
    cip: { gpu: false, home: directory, tmp: "/proj/ciptmp" },
    request: request("bash", {
      command: "trap 'printf checkpoint > checkpoint; exit 0' TERM; while :; do sleep 0.1; done",
      timeout: 10,
    }),
  };
  const run = async (source: string, input: any) => {
    const child = Bun.spawn(["python3", "-I", "-B", "-c", source, source], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    const output = await new Response(child.stdout).text();

    expect(await child.exited).toBe(0);

    return JSON.parse(output);
  };

  try {
    const answer = await run(patched, payload);

    expect(answer.value.details.cipEvent).toBe("occupied");
    expect(await Bun.file(join(directory, "checkpoint")).text()).toBe("checkpoint");
  } finally {
    await run(code, { operation: "cleanup", session });
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test("the public SSH trust file is re-read in one running process, including newly trusted CIP keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cip-keys-"));

  await mkdir(join(directory, ".ssh"));

  const file = join(directory, ".ssh/known_hosts");

  await writeFile(file, "other.example ssh-ed25519 AAAA\n");

  const source = `
import { knownHostKeys, acceptCipHostKey } from ${JSON.stringify(new URL("../../remote/host-keys.ts", import.meta.url).pathname)};
const host="cip7b0.cip.cs.fau.de";
let missing=false;
try { await knownHostKeys(host); } catch { missing=true; }
await Bun.write(${JSON.stringify(file)}, host+" ssh-ed25519 AAAA\\n");
const accepted=await acceptCipHostKey(host);
await Bun.write(${JSON.stringify(file)}, host+" ssh-ed25519 BBBB\\n");
console.log(JSON.stringify({missing,accepted,fresh:await knownHostKeys(host)}));
`;

  try {
    const child = Bun.spawn([process.execPath, "--eval", source], {
      stdout: "pipe",
      stderr: "pipe",
      env: { HOME: directory, PATH: "/usr/bin:/bin" },
      timeout: 10000,
    });
    const output = await new Response(child.stdout).text();

    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({
      missing: true,
      accepted: "cip7b0.cip.cs.fau.de ssh-ed25519 AAAA\n",
      fresh: "cip7b0.cip.cs.fau.de ssh-ed25519 BBBB\n",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CIP observations distinguish local seats from SSH and parse colored quota output", async () => {
  const code = await workerSource;
  const script = code.replace(
    'sys.modules["pi_remote.worker"].run()',
    `
module=sys.modules["pi_remote.cip"]
class Result:
    returncode=0
    def __init__(self,text): self.stdout=text.encode()
def fake(argv,**kwargs):
    if argv[0]=="cip-quota":
        assert kwargs["env"]["HOME"]
        return Result("  28 MiB of 32 MiB used ("+chr(27)+"[32m86%"+chr(27)+"[0m) in /home/cip/test\\n  56 MiB of 64 MiB used (86%) in /proj/ciptmp\\n")
    if argv[1]=="list-sessions": return Result("1 local\\n2 ssh\\n")
    if argv[2]=="1": return Result("Name=local-user\\nRemote=no\\nSeat=seat0\\nTTY=tty7\\nType=wayland\\n")
    return Result("Name=remote-user\\nRemote=no\\nSeat=\\nTTY=pts/0\\nType=tty\\n")
module.subprocess.run=fake
module.os.path.isdir=lambda path: True
print(json.dumps(module.status()))`,
  );
  const child = Bun.spawn(["python3", "-I", "-B", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  const output = await new Response(child.stdout).text();

  expect(await child.exited).toBe(0);

  const status = JSON.parse(output);

  expect(status.occupants).toEqual(["local-user"]);
  expect(status.quota).toHaveLength(2);
  expect(status.quota[0].percent).toBe(86);
  expect(status.quotaText).not.toContain("\x1b");
});

test("CIP account-mode consent covers the bounded pool, while a declined fallback allocates nothing", async () => {
  const f = fixture();
  const original = f.io.call;

  f.io.call = async (...args) => ({
    ...(await original(...args)),
    sandbox: false,
    reason: "User namespaces disabled",
  });

  let confirmations = 0;

  f.ctx.ui.confirm = async (_title: string, question: string) => {
    confirmations++;
    expect(question).toContain("FAU CIP workstation pool");

    return false;
  };
  await expect(f.pool.acquire()).rejects.toThrow("declined");
  expect(f.pool.state.nodes).toHaveLength(0);
  f.ctx.ui.confirm = async () => {
    confirmations++;

    return true;
  };
  await f.pool.acquire();
  await f.pool.acquire();
  expect(confirmations).toBe(2);
  expect(f.pool.state.nodes.every((node) => node.target.isolation === "confirmed-account")).toBe(
    true,
  );
});

test("operator /cip takes only a workspace path, uses the cached account and can leave an empty remote pool", async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), "pi-cip-user-"));
  const previous = process.env.FAUCIP_USER_CACHE_FILE;
  const path = join(directory, "user");

  await writeFile(path, "synthetic\n");
  process.env.FAUCIP_USER_CACHE_FILE = path;

  const controller = new RemoteController(f.pi, { call: f.io.call, keys: f.io.freshKeys }, f.io);

  controller.bind(f.ctx);

  try {
    await controller.command("project with spaces", f.ctx, true);

    const route = sessionServices(f.ctx).remote!;

    expect(route.target()).toMatchObject({ user: "synthetic", folder: "project with spaces" });

    const prepared = await route.prepare(
      request("cip_nodes", { operation: "release", node: "cip-1" }),
      {} as any,
      "actor",
      false,
    );

    await prepared.execute();
    expect(route.context?.()).toContain("max 4");
    expect(route.target()).toBeDefined();
    await expect(route.prepare(request(), {} as any, "actor", false)).rejects.toThrow(
      "not allocated",
    );
    await controller.command("off", f.ctx);
    expect(route.target()).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.FAUCIP_USER_CACHE_FILE;
    else process.env.FAUCIP_USER_CACHE_FILE = previous;

    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CIP file tools enforce reviewed shared-path grants and GPU sandbox arguments expose only requested devices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cip-paths-"));
  const root = join(directory, "project"),
    shared = join(directory, "shared");

  await mkdir(root);
  await mkdir(shared);

  const path = join(shared, "data.txt");

  await writeFile(path, "original");

  const session = randomUUID();
  const code = await workerSource;
  const patched = code.replace(
    'sys.modules["pi_remote.worker"].run()',
    'sys.modules["pi_remote.cip"].guard=lambda: None\nsys.modules["pi_remote.worker"].run()',
  );
  const run = async (input: any) => {
    const child = Bun.spawn(["python3", "-I", "-B", "-c", patched, patched], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    const output = await new Response(child.stdout).text();

    expect(await child.exited).toBe(0);

    return JSON.parse(output);
  };
  const payload = {
    operation: "execute",
    session,
    root,
    isolation: "confirmed-account",
    cip: { gpu: false, home: directory, tmp: "/proj/ciptmp" },
    request: {
      ...request("write", { path: "../shared/data.txt", content: "updated" }),
      sandbox: { paths: [{ path: shared, access: "read" }] },
    },
  };

  try {
    const denied = await run({ ...payload, action: randomUUID() });

    expect(denied.error).toContain("read-only");
    expect(await Bun.file(path).text()).toBe("original");
    payload.request.sandbox.paths[0].access = "write";
    expect((await run({ ...payload, action: randomUUID() })).value.isError).not.toBe(true);
    expect(await Bun.file(path).text()).toBe("updated");
    payload.request.sandbox.paths[0].path = "/etc";
    expect((await run({ ...payload, action: randomUUID() })).error).toContain(
      "home or /proj/ciptmp",
    );

    const script = code.replace(
      'sys.modules["pi_remote.worker"].run()',
      `
worker=sys.modules["pi_remote.worker"]
worker.glob.glob=lambda pattern: ["/dev/nvidia0","/dev/nvidiactl"]
print(json.dumps(worker.sandbox_argv("/project","/private",False,"none",{},"code",True,[{"path":"/proj/ciptmp/data","access":"read"}])))`,
    );
    const child = Bun.spawn(["python3", "-I", "-B", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const argv = JSON.parse(await new Response(child.stdout).text());

    expect(await child.exited).toBe(0);
    expect(argv.join(" ")).toContain("--dev-bind /dev/nvidia0 /dev/nvidia0");
    expect(argv.join(" ")).toContain("--ro-bind /proj/ciptmp/data /proj/ciptmp/data");
    expect(argv).not.toContain("--share-net");
  } finally {
    await run({ operation: "cleanup", session });
    await rm(directory, { recursive: true, force: true });
  }
});

test("late occupancy observations cannot migrate an already-replaced slot again", async () => {
  const f = fixture();
  const node = await f.pool.acquire({ host: "cip7b1", gpuModel: "3070" });
  const original = f.io.call;
  let began!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let first = true;

  f.io.call = async (...args) => {
    if (args[1].operation === "cip_status" && first) {
      first = false;
      began();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });

      return { ...health, occupants: ["old local user"] };
    }

    return await original(...args);
  };

  const command = { ...request(), sandbox: { cip: { node: node.id } } };
  const delayed = f.pool.prepare(command, f.build);

  await started;
  f.occupied.add(hostname(1));

  const fresh = await f.pool.prepare(command, f.build);

  finish();
  expect((await delayed).target.host).toBe(fresh.target.host);
  expect(f.messages).toHaveLength(1);
});

test("an occupied idle slot with no replacement is dropped before a command can be reviewed", async () => {
  const f = fixture();

  await f.pool.acquire({ host: "cip7b1", gpuModel: "3070" });
  f.machines
    .filter((machine) => machine.gpu.includes("3070"))
    .forEach((machine) => f.occupied.add(machine.host));
  await expect(f.pool.prepare(request(), f.build)).rejects.toThrow("slot dropped");
  expect(f.pool.state.nodes).toHaveLength(0);

  const listing = await f.pool.prepare(request("cip_nodes", { operation: "list" }), f.build);

  expect((await listing.execute()).content[0]).toMatchObject({ type: "text" });
  expect(f.calls.some((call) => call.input.operation === "execute")).toBe(false);
});
