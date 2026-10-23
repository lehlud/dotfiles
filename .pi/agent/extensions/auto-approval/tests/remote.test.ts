import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { RemoteController } from "../../remote/controller.ts";
import { workerSource } from "../../remote/source.ts";
import { forwarding, Tunnels } from "../../remote/tunnels.ts";
import { sshOptions } from "../../remote/ssh.ts";
import { label, parseTarget, validateTarget } from "../../remote/target.ts";
import { executionTimeout, prepareRemote, validateRemoteRequest } from "../../remote/operations.ts";
import { registerInheritedRemote, registerRemoteContext } from "../../shared/session/remote.ts";
import { sessionServices } from "../../shared/session/services.ts";
import type { SelectionIO } from "../../remote/selection.ts";
import { tunnelTool, type RemoteTarget } from "../../shared/contracts/remote.ts";
import type { Request } from "../../shared/contracts/action.ts";

const project = await mkdtemp(join(tmpdir(), "pi-remote-tests-"));
const source = await workerSource;
const sessions = new Set<string>();
const target: RemoteTarget = {
  user: "alice",
  host: "test.example",
  folder: "project",
  root: "/home/alice/project",
  isolation: "bwrap",
  knownHosts: "test.example ssh-ed25519 synthetic-public-host-key\n",
};
const account: RemoteTarget = {
  ...target,
  isolation: "confirmed-account",
  confirmation: { source: "operator-ui", reason: "Namespaces disabled by remote kernel" },
};
const request = (
  tool = "read",
  args: Record<string, unknown> = { path: "README.md" },
): Request => ({
  tool,
  arguments: args,
  goal: "Work in the selected remote project",
  justification: "Test exact operation",
});

async function worker(input: Record<string, unknown>) {
  const process = Bun.spawn(["python3", "-I", "-B", "-c", source, source], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", PI_TEST_SECRET: "must-not-reach-remote-commands" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  expect(await process.exited).toBe(0);
  expect(stderr).toBe("");

  const answer = JSON.parse(stdout);

  expect(answer.protocol).toBe("pi-remote-v1");

  return answer;
}

function actor() {
  const id = randomUUID();

  sessions.add(id);

  return id;
}

function execute(action: Request, session = actor(), extra: Record<string, unknown> = {}) {
  return worker({
    operation: "execute",
    root: project,
    session,
    action: randomUUID(),
    isolation: "confirmed-account",
    request: action,
    ...extra,
  });
}

const text = (answer: any) => answer.value.content[0].text as string;

afterAll(async () => {
  for (const session of sessions) await worker({ operation: "cleanup", session });

  await rm(project, { recursive: true, force: true });
});

test("target parsing never treats user input as SSH options or shell code", () => {
  expect(parseTarget("alice@cip5b4.cip.cs.fau.de:flatscan-1shot")).toEqual({
    user: "alice",
    host: "cip5b4.cip.cs.fau.de",
    folder: "flatscan-1shot",
  });
  expect(parseTarget("alice@test.example:folder with spaces; $(never-executed)").folder).toContain(
    "$(never-executed)",
  );

  for (const value of [
    "-oProxyCommand=x@host:foo",
    "alice@-host:foo",
    "alice@host:foo\nbar",
    "alice@host:~root/private",
    "host:foo",
  ])
    expect(() => parseTarget(value)).toThrow();

  expect(label(target)).toBe("alice@test.example:project");
  expect(() => validateTarget({ ...account, confirmation: undefined })).toThrow("operator UI");
  expect(() =>
    validateTarget({ ...account, confirmation: { source: "model", reason: "approved" } }),
  ).toThrow();
  expect(() => validateTarget(null)).toThrow();
});

test("SSH ignores config, pins known hosts and authenticates only through the agent", () => {
  const options = sshOptions(target);

  for (const value of [
    "/dev/null",
    "IdentityFile=none",
    "IdentityAgent=/ssh-agent",
    "ForwardAgent=no",
    "StrictHostKeyChecking=yes",
    "UserKnownHostsFile=/known_hosts",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "GSSAPIAuthentication=no",
    "ProxyCommand=none",
    "PermitLocalCommand=no",
  ])
    expect(options).toContain(value);

  expect(options.at(-1)).toBe("alice@test.example");
  expect(options).not.toContain("-A");
});

test("remote plan binds isolation consent, host identity, cwd and exact requested expansions", () => {
  const action = request("bash", { command: "npm install", timeout: 60 });

  action.sandbox = { network: "host", limits: { maxOutputBytes: 4096 } };

  const prepared = prepareRemote(account, action, actor(), false, () => {}, new Tunnels());

  expect(prepared.plan).toMatchObject({
    backend: "ssh",
    workspace: account.root,
    requested: action.sandbox,
    remote: { isolation: "confirmed-account", confirmation: account.confirmation },
  });
  expect((prepared.plan.remote as any).hostKeysHash).toHaveLength(64);
  expect(executionTimeout(action)).toBe(60000);
  expect(executionTimeout({ ...action, arguments: { timeout: 600 } })).toBe(600000);
  expect(() => executionTimeout({ ...action, arguments: { timeout: 86400 } })).toThrow("23 hours");

  for (const sandbox of [
    { network: "none" },
    { tools: ["node"] },
    { paths: [{ path: "/home", access: "read" }] },
    { limits: { memoryMiB: 1024 } },
    { limits: { pids: 64 } },
    { limits: { cpus: 1 } },
    { limits: { tmpBytes: 1048576 } },
  ])
    expect(() => validateRemoteRequest({ ...action, sandbox } as Request, account)).toThrow();

  expect(() =>
    validateRemoteRequest({ ...action, sandbox: { network: "none" } }, target),
  ).not.toThrow();
});

test("tunnel grants require explicit network approval, loopback listeners and bounded endpoints", () => {
  const spec = {
    operation: "open",
    direction: "local",
    port: 8080,
    destinationHost: "localhost",
    destinationPort: 3000,
  };

  expect(Check(tunnelTool.parameters, spec)).toBe(true);
  expect(Check(tunnelTool.parameters, { ...spec, bindAddress: "0.0.0.0" })).toBe(false);
  expect(forwarding(spec as any)).toEqual(["-L", "127.0.0.1:8080:localhost:3000"]);
  expect(forwarding({ ...spec, direction: "remote", destinationHost: "::1" } as any)).toEqual([
    "-R",
    "127.0.0.1:8080:[::1]:3000",
  ]);

  for (const change of [
    { direction: "socks" },
    { port: 22 },
    { destinationHost: "x:22 -A" },
    { lifetimeSeconds: 999999 },
  ])
    expect(() => forwarding({ ...spec, ...change } as any)).toThrow();

  expect(() => validateRemoteRequest(request("remote_tunnel", spec), target)).toThrow("network");
  expect(() =>
    validateRemoteRequest(
      { ...request("remote_tunnel", spec), sandbox: { network: "host" } },
      account,
    ),
  ).not.toThrow();
});

function controllerFixture(sandbox = false, accepted = true) {
  const entries: any[] = [],
    notifications: any[] = [],
    probes: any[] = [],
    confirmations: any[] = [];
  const ctx: any = {
    mode: "print",
    hasUI: true,
    cwd: project,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries, getSessionId: () => "root-session" },
    ui: {
      setStatus: () => {},
      notify: (...args: any[]) => notifications.push(args),
      confirm: async (...args: any[]) => {
        confirmations.push(args);

        return accepted;
      },
    },
  };
  const pi: any = {
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
  };
  const io: SelectionIO = {
    keys: async () => target.knownHosts,
    call: async (_target, input) => {
      probes.push(input);

      return { root: target.root, system: "Linux", sandbox, reason: "namespace creation failed" };
    },
  };
  const controller = new RemoteController(pi, io);

  controller.bind(ctx);

  return { controller, entries, ctx, probes, confirmations, notifications, io };
}

test("failed bwrap probe requires operator confirmation; decline and headless mode do not enable fallback", async () => {
  const declined = controllerFixture(false, false);

  await declined.controller.command(label(target), declined.ctx);
  expect(sessionServices(declined.ctx).remote!.target()).toBeUndefined();
  expect(declined.confirmations).toHaveLength(1);

  const headless = controllerFixture();

  headless.ctx.hasUI = false;
  await expect(headless.controller.command(label(target), headless.ctx)).rejects.toThrow(
    "operator UI",
  );

  const confirmed = controllerFixture();

  await confirmed.controller.command(label(target), confirmed.ctx);
  expect(sessionServices(confirmed.ctx).remote!.target()).toMatchObject({
    isolation: "confirmed-account",
    confirmation: { source: "operator-ui" },
  });
  expect(confirmed.probes).toEqual([{ operation: "probe", folder: "project" }]);
  expect(confirmed.confirmations[0][1]).toContain("no remote OS/filesystem/network isolation");
});

test("working sandbox needs no fallback confirmation; busy sessions cannot change execution target", async () => {
  const fixture = controllerFixture(true);

  await fixture.controller.command(label(target), fixture.ctx);
  expect(fixture.confirmations).toHaveLength(0);

  const prepared = sessionServices(fixture.ctx).remote!.prepare(
    request(),
    {} as any,
    "root",
    false,
  );

  fixture.ctx.isIdle = () => false;
  await expect(fixture.controller.command("off", fixture.ctx)).rejects.toThrow("settle");
  fixture.ctx.isIdle = () => true;
  await fixture.controller.command("off", fixture.ctx);
  expect(() => prepared.assertCurrent()).toThrow("changed");
});

test("invalid saved target fails closed and a session change cancels an outstanding consent dialog", async () => {
  const fixture = controllerFixture();

  fixture.entries.push({
    type: "custom",
    customType: "remote-workspace",
    data: { ...account, confirmation: undefined },
  });
  fixture.controller.bind(fixture.ctx);
  expect(() => sessionServices(fixture.ctx).remote!.target()).toThrow("invalid");
  await fixture.controller.command("off", fixture.ctx);

  let release!: (accepted: boolean) => void;

  fixture.ctx.ui.confirm = () =>
    new Promise<boolean>((resolve) => {
      release = resolve;
    });

  const selecting = fixture.controller.command(label(target), fixture.ctx);

  while (!release) await Bun.sleep(1);

  fixture.controller.bind(fixture.ctx);
  release(true);
  await expect(selecting).rejects.toThrow();
  expect(sessionServices(fixture.ctx).remote!.target()).toBeUndefined();
});

test("child sessions inherit the trusted remote route; contextual instructions do not grant execution", () => {
  const parent = controllerFixture();
  const events: Record<string, Function> = {};
  const child: any = { sessionManager: {} };

  registerInheritedRemote(
    {
      on: (name: string, handler: Function) => {
        events[name] = handler;
      },
    } as any,
    parent.ctx,
  );
  events.session_start({}, child);
  expect(sessionServices(child).remote).toBe(sessionServices(parent.ctx).remote);
  sessionServices(parent.ctx).remote = { target: () => account } as any;
  registerRemoteContext({
    on: (_name: string, handler: Function) => {
      events.context = handler;
    },
  } as any);

  const result = events.context({ messages: [] }, parent.ctx);

  expect(result.messages[0].content).toContain("API credentials");
  expect(result.messages[0].content).toContain("untrusted DATA");
  expect(events.context({ messages: result.messages }, parent.ctx).messages).toHaveLength(1);
});

test("remote file tools preserve exact edits, render native numbered diffs and reject escaping paths", async () => {
  expect(
    text(await execute(request("write", { path: "example.txt", content: "alpha\nbeta\ngamma\n" }))),
  ).toContain("Wrote");

  const edited = await execute(
    request("edit", { path: "example.txt", edits: [{ oldText: "beta", newText: "changed" }] }),
  );

  expect(edited.value.details.diff).toContain("-2 beta");
  expect(edited.value.details.diff).toContain("+2 changed");
  expect(text(await execute(request("read", { path: "example.txt", offset: 2, limit: 1 })))).toBe(
    "changed\n",
  );

  const overlap = await execute(
    request("edit", {
      path: "example.txt",
      edits: [
        { oldText: "alpha", newText: "one" },
        { oldText: "alpha\nchanged", newText: "two" },
      ],
    }),
  );

  expect(overlap.error).toContain("overlap");
  expect((await execute(request("read", { path: "/etc/passwd" }))).error).toContain("scoped");
  await symlink("/etc/passwd", join(project, "escape"));
  expect((await execute(request("read", { path: "escape" }))).error).toContain("scoped");
  expect(
    (
      await execute(request("write", { path: "forbidden", content: "no" }), actor(), {
        readOnly: true,
      })
    ).error,
  ).toContain("Read-only");
});

test("search honors file globs, literal mode, case handling and context", async () => {
  await writeFile(join(project, "search.txt"), "before\nHELLO [world]\nafter\n");

  const result = await execute(
    request("grep", {
      path: ".",
      pattern: "hello [world]",
      literal: true,
      ignoreCase: true,
      glob: "search.txt",
      context: 1,
    }),
  );

  expect(text(result)).toContain("search.txt-1:before");
  expect(text(result)).toContain("search.txt:2:HELLO [world]");
  expect(text(await execute(request("find", { pattern: "search.*" })))).toBe("search.txt");
});

test("remote private tmp persists per actor, excludes host environment and is removed by cleanup", async () => {
  const session = actor();

  await execute(request("write", { path: "/tmp/persistent", content: "retained" }), session);
  expect(text(await execute(request("read", { path: "/tmp/persistent" }), session))).toBe(
    "retained",
  );

  const probe = await execute(
    request("bash", { command: 'printf "%s|%s" "$PI_TEST_SECRET" "$TMPDIR"' }),
    session,
  );

  expect(text(probe)).toBe(`|/tmp/pi-remote-${process.getuid!()}-${session}/tmp`);
  expect((await execute(request("read", { path: "/tmp/persistent" }))).error).toContain(
    "No such file",
  );
  await worker({ operation: "cleanup", session });
  expect((await execute(request("read", { path: "/tmp/persistent" }), session)).error).toContain(
    "No such file",
  );
});

test("both remote sandbox modes support cwd; bwrap isolates workspace, private tmp and network", async () => {
  const session = actor();
  const command = request("bash", {
    command: 'pwd; printf "%s|%s" "$HOME" "$TMPDIR"; test ! -e /home/gunter/.pi/agent/auth.json',
  });
  const result = await execute(command, session, { isolation: "bwrap" });

  expect(result.error).toBeUndefined();
  expect(text(result)).toContain(`${project}\n/tmp/home|/tmp`);
  await execute(request("write", { path: "/tmp/isolated-file", content: "hello" }), session, {
    isolation: "bwrap",
  });
  expect(
    text(
      await execute(request("read", { path: "/tmp/isolated-file" }), session, {
        isolation: "bwrap",
      }),
    ),
  ).toBe("hello");
});

test("output and time bounds stop commands; stale cancellation never kills a reused PID", async () => {
  const noisy = request("bash", { command: "python3 -c 'print(\"x\" * 10000)'" });

  noisy.sandbox = { limits: { maxOutputBytes: 1024 } };
  expect((await execute(noisy)).error).toContain("output limit");

  const slow = request("bash", { command: "sleep 60" });

  slow.sandbox = { limits: { executionTimeoutMs: 1000 } };

  const began = Date.now();

  expect((await execute(slow)).error).toContain("deadline");
  expect(Date.now() - began).toBeLessThan(4000);

  const session = actor(),
    action = randomUUID();
  const base = `/tmp/pi-remote-${process.getuid!()}-${session}`;

  await execute(request("ls", {}), session);
  await writeFile(
    join(base, "jobs", action),
    JSON.stringify({ pid: process.pid, start: "impossible-start-time" }),
  );

  const cancelled = await worker({ operation: "cancel", session, action });

  expect(cancelled.value).toEqual({
    cancelled: false,
    reason: "Process ended or identity changed; nothing killed",
  });
});

test("public Git identity is scoped to one remote command and its temporary config is removed", async () => {
  const directory = join(project, "git-project");

  await mkdir(directory);

  const create = request("bash", {
    command: "git init -q git-project; cd git-project; printf hello > example; git add example",
  });

  expect((await execute(create)).error).toBeUndefined();

  const session = actor();
  const answer = await worker({
    operation: "execute",
    root: directory,
    session,
    action: randomUUID(),
    isolation: "confirmed-account",
    request: request("git", { argv: ["commit", "-m", "Synthetic test commit"] }),
    gitConfig: "[user]\nname = Synthetic Test\nemail = test@example.invalid\n",
  });

  expect(answer.error).toBeUndefined();
  expect(answer.value.isError).toBe(false);

  const after = await execute(request("find", { path: "/tmp", pattern: ".public-git-*" }), session);

  expect(text(after)).toBe("");
});

test("tunnels wait for trusted complete readiness, remain owner-scoped and close on cancellation", async () => {
  let child: any;
  const tunnels = new Tunnels(async (_target, argv, _command, forward) => {
    expect(argv).toContain("ExitOnForwardFailure=yes");
    expect(forward).toBe(true);
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    setTimeout(() => {
      child.stdout.write("PI_SSH_");
      child.stdout.write("FORWARD_READY\n");
    }, 5);

    return child;
  });
  const cancellation = new AbortController();
  const result = await tunnels.open(
    target,
    { direction: "local", port: 18080, destinationHost: "localhost", destinationPort: 3000 },
    "owner",
    cancellation.signal,
  );

  expect(result.state).toBe("open");
  expect(tunnels.list("someone-else")).toEqual([]);
  expect(() => tunnels.close(result.id, "someone-else")).toThrow();
  cancellation.abort();
  expect(tunnels.list("owner")[0].state).toBe("closed");
  tunnels.closeAll();
});

test("remote cleanup leases survive a restart and never delete an active actor's tmp", async () => {
  const fixture = controllerFixture();
  const original = fixture.io.call;
  const calls: any[] = [];

  fixture.io.call = async (selected, input, ...rest) => {
    if (input.operation === "probe") return original(selected, input, ...rest);

    calls.push(input);

    if (input.operation === "cleanup") return { cleaned: true };

    expect(
      fixture.entries.some(
        (entry) =>
          entry.customType === "remote-workspace-cleanup" &&
          entry.data.session === input.session &&
          entry.data.pending,
      ),
    ).toBe(true);

    return { content: [{ type: "text", text: "Synthetic remote result" }] };
  };
  await fixture.controller.command(label(target), fixture.ctx);

  const route = sessionServices(fixture.ctx).remote!;

  await route.prepare(request(), {} as any, "actor", false).execute();
  await route.prepare(request(), {} as any, "actor", false).execute();
  expect(calls.map((input) => input.operation)).toEqual(["execute", "execute"]);
  expect(calls[0].session).toBe(calls[1].session);
  fixture.controller.bind(fixture.ctx);
  await sessionServices(fixture.ctx)
    .remote!.prepare(request(), {} as any, "actor", false)
    .execute();
  expect(calls[2]).toEqual({ operation: "cleanup", session: calls[0].session });
  expect(calls[3].session).not.toBe(calls[0].session);
  await fixture.controller.stop();
  expect(calls.at(-1).operation).toBe("cleanup");
});

test("a lost remote response cancels owned work and never replays the submitted command", async () => {
  const calls: any[] = [];
  const prepared = prepareRemote(
    account,
    request("bash", { command: "touch one-time-output" }),
    actor(),
    false,
    () => {},
    new Tunnels(),
    async (_target, input) => {
      calls.push(input);

      if (input.operation === "execute") throw new Error("Synthetic SSH disconnect after dispatch");

      return { cancelled: true };
    },
  );

  await expect(prepared.execute()).rejects.toThrow("No replay");
  expect(calls.map((input) => input.operation)).toEqual(["execute", "cancel"]);
  expect(calls[1].action).toBe(calls[0].action);
  expect(calls[1].session).toBe(calls[0].session);
});

test("unreachable cleanup remains pending, warns the operator and retries only owned cleanup", async () => {
  const fixture = controllerFixture();
  const original = fixture.io.call;

  fixture.io.call = async (selected, input, ...rest) => {
    if (input.operation === "probe") return original(selected, input, ...rest);

    if (input.operation === "cleanup") throw new Error("Synthetic host unavailable");

    return { content: [{ type: "text", text: "Synthetic remote result" }] };
  };
  await fixture.controller.command(label(target), fixture.ctx);
  await sessionServices(fixture.ctx)
    .remote!.prepare(request(), {} as any, "actor", false)
    .execute();
  await fixture.controller.stop();
  expect(fixture.notifications.at(-1)[0]).toContain("cleanup is pending");

  const lease = fixture.entries
    .filter((entry) => entry.customType === "remote-workspace-cleanup")
    .at(-1);

  expect(lease.data.pending).toBe(true);

  const calls: any[] = [];

  fixture.io.call = async (_selected, input) => {
    calls.push(input);

    return input.operation === "cleanup" ? { cleaned: true } : { content: [] };
  };
  await sessionServices(fixture.ctx)
    .remote!.prepare(request(), {} as any, "new-actor", false)
    .execute();
  expect(calls[0]).toEqual({ operation: "cleanup", session: lease.data.session });
  expect(calls.filter((input) => input.operation === "execute")).toHaveLength(1);
  await fixture.controller.stop();
});

test("remote bwrap enforces offline versus explicitly connected execution", async () => {
  const { createServer } = await import("node:net");
  const server = createServer((socket) => socket.end());

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = (server.address() as { port: number }).port;
  const action = request("bash", {
    command: `python3 -c 'import socket; socket.create_connection(("127.0.0.1", ${port}), timeout=0.2).close(); print("connected")'`,
  });

  try {
    const offline = await execute(action, actor(), { isolation: "bwrap" });

    expect(offline.value.isError).toBe(true);

    const connected = await execute({ ...action, sandbox: { network: "host" } }, actor(), {
      isolation: "bwrap",
    });

    expect(connected.value.isError).toBe(false);
    expect(text(connected)).toBe("connected\n");

    const requiredOffline = await execute({ ...action, sandbox: { network: "none" } });

    expect(requiredOffline.error).toContain("cannot be enforced");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Escape cancels a remote connection probe before it can change the workspace", async () => {
  const fixture = controllerFixture();
  let terminalInput!: (input: string) => void;
  let probing = false;

  fixture.ctx.mode = "tui";
  fixture.ctx.ui.onTerminalInput = (handler: typeof terminalInput) => {
    terminalInput = handler;

    return () => {};
  };
  fixture.io.call = async (_target, _input, signal) => {
    probing = true;

    return await new Promise((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(new Error("Probe interrupted")), {
        once: true,
      }),
    );
  };
  fixture.controller.bind(fixture.ctx);

  const selecting = fixture.controller.command(label(target), fixture.ctx);

  while (!probing) await Bun.sleep(1);

  terminalInput("\x1b");
  await expect(selecting).rejects.toThrow("interrupted");
  expect(sessionServices(fixture.ctx).remote!.target()).toBeUndefined();
  expect(fixture.confirmations).toEqual([]);
  fixture.controller.detach();
});

test("SSH worker encoding preserves quoted backslashes through POSIX and Fish login-shell parsing", async () => {
  const { workerCommand } = await import("../../remote/client.ts");
  const snippet = String.raw`import json
print(json.dumps(r"literal\\path 'quote' $HOME !"))
`;
  const shells = [["/bin/sh", "-c"]];
  const fish = Bun.which("fish", { PATH: "/usr/bin:/bin" });

  if (fish) shells.push([fish, "--no-config", "-c"]);

  for (const argv of shells) {
    const child = Bun.spawn([...argv, workerCommand(snippet)], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: project },
    });
    const output = await new Response(child.stdout).text();

    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toBe(String.raw`literal\\path 'quote' $HOME !`);
  }
});
