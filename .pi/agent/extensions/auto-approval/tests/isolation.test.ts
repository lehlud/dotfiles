import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  detectWorkspace,
  validateWorkspace,
  sandboxArguments,
  sandboxHostPath,
  executeIsolated,
  type SandboxConfig,
} from "../isolation.ts";
import type { Request } from "../../shared/contracts/action.ts";

const fixture = await mkdtemp(join(tmpdir(), "pi-isolation-test-"));
const home = join(fixture, "home");
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], { stdout: "pipe", stderr: "pipe" });

  if (result.exitCode) throw new Error(result.stderr.toString());

};

beforeAll(async () => {
  await mkdir(home);
  git("init", "-q", home);
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

test("non-repo children of a home dotfiles repository keep their own cwd", async () => {
  const cwd = join(home, "loose", "nested");

  await mkdir(cwd, { recursive: true });
  expect(await detectWorkspace(cwd, home)).toEqual({ path: cwd, cwd });
  expect(await detectWorkspace(home, home)).toEqual({ path: home, cwd: home });
});

test("a project's own Git root is used without changing execution cwd", async () => {
  const root = join(home, "project");
  const cwd = join(root, "src");

  await mkdir(cwd, { recursive: true });
  git("init", "-q", root);
  expect(await detectWorkspace(cwd, home)).toEqual({ path: root, cwd });
});

test("Git roots above home do not enlarge a workspace", async () => {
  const outer = join(fixture, "outer");
  const fakeHome = join(outer, "user");
  const cwd = join(fakeHome, "loose");

  await mkdir(cwd, { recursive: true });
  git("init", "-q", outer);
  expect(await detectWorkspace(cwd, fakeHome)).toEqual({ path: cwd, cwd });
});

test("no Git repository and symlinked cwd both resolve to the actual directory", async () => {
  const cwd = join(fixture, "plain");
  const alias = join(fixture, "alias");

  await mkdir(cwd);
  await symlink(cwd, alias);
  expect(await detectWorkspace(alias, home)).toEqual({ path: cwd, cwd });
});

const bwrap = Bun.which("bwrap");
const nativeTest = process.platform === "linux" && bwrap ? test : test.skip;
let native: SandboxConfig;
let project: string;
let privateTmp: string;

beforeAll(async () => {
  if (!bwrap || process.platform !== "linux") return;

  const runner = join(fixture, "runner");
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      resolve(import.meta.dir, "../runner.ts"),
      "--outfile",
      runner,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode) throw new Error(result.stderr.toString());

  native = { backend: "bwrap", executable: bwrap, runnerExecutable: runner };
  project = join(fixture, "native-project");
  await mkdir(project);
  privateTmp = await mkdtemp(join(fixture, "session-tmp-"));
});

const action = (tool: string, args: Record<string, unknown>) => ({
  tool,
  arguments: args,
  goal: "Sandbox integration test",
  justification: "Verify containment in a temporary test fixture",
});
const run = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal) =>
  executeIsolated(
    action(tool, args),
    await validateWorkspace(project, native, [], undefined, privateTmp),
    native,
    signal,
  );
const scoped = async (request: Request) =>
  executeIsolated(
    request,
    await validateWorkspace(project, native, [], request.sandbox, privateTmp),
    native,
  );

nativeTest(
  "writing receipts run offline inside the real sandbox with original Unicode",
  async () => {
    const text = "自転車の修理を承ります。 نصلح الدراجات.";
    const result = await run("writing_check", { text, audience: "public", format: "plain" });
    const { createHash } = await import("node:crypto");

    expect(result.details.checked).toBe(true);
    expect(result.details.textHash).toBe(createHash("sha256").update(text).digest("hex"));
    expect((await run("writing_check", { text, audience: "operator" })).details.checked).toBe(
      false,
    );
    await expect(run("writing_check", { text, audience: "invalid" })).rejects.toThrow(
      "Invalid writing check arguments",
    );
  },
);

nativeTest("empty legacy workspaceRoots do not disable automatic detection", async () => {
  expect((await validateWorkspace(project, { ...native, workspaceRoots: [] }, [])).path).toBe(
    project,
  );
});

nativeTest(
  "additional mounts enforce read/write rights and disappear on the next action",
  async () => {
    const shared = join(fixture, "shared-input.txt");

    await writeFile(shared, "shared-source");

    const read: Request = {
      ...action("bash", {
        command: `test -r '${shared}' && test ! -w '${shared}' && cat '${shared}'`,
      }),
      sandbox: { paths: [{ path: shared, access: "read" }] },
    };

    expect(JSON.stringify((await scoped(read)).content)).toContain("shared-source");
    await expect(
      scoped({ ...action("write", { path: shared, content: "forbidden" }), sandbox: read.sandbox }),
    ).rejects.toThrow();
    expect(await readFile(shared, "utf8")).toBe("shared-source");
    await scoped({
      ...action("write", { path: shared, content: "approved-change" }),
      sandbox: { paths: [{ path: shared, access: "write" }] },
    });
    expect(await readFile(shared, "utf8")).toBe("approved-change");
    expect(
      JSON.stringify(
        (await run("bash", { command: `test ! -e '${shared}' && printf expired` })).content,
      ),
    ).toContain("expired");
  },
);
nativeTest(
  "reviewed network and literal environment overrides expire after execution",
  async () => {
    const hostNet = await import("node:fs/promises").then((fs) => fs.readlink("/proc/self/ns/net"));
    const request: Request = {
      ...action("bash", {
        command: 'readlink /proc/self/ns/net; printf "%s" "$PI_TEST_REVIEWED_VALUE"',
      }),
      sandbox: {
        network: "host",
        environment: { PI_TEST_REVIEWED_VALUE: "literal $(not-executed) value" },
      },
    };
    const text = JSON.stringify((await scoped(request)).content);

    expect(text).toContain(hostNet);
    expect(text).toContain("literal $(not-executed) value");

    const later = JSON.stringify(
      (
        await run("bash", {
          command:
            'readlink /proc/self/ns/net; test -z "${PI_TEST_REVIEWED_VALUE+x}" && printf default-env',
        })
      ).content,
    );

    expect(later).not.toContain(hostNet);
    expect(later).toContain("default-env");
  },
);

nativeTest(
  "a network action never grants connectivity to an already-running offline process",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("network-proof"),
    });
    const controller = new AbortController();
    let pending: Promise<any> | undefined;

    try {
      const probe = `import socket,time,pathlib,os
start=pathlib.Path('online-start'); end=pathlib.Path('online-end')
before=os.readlink('/proc/self/ns/net'); failures=0
pathlib.Path('offline-ready').write_text('ready')
deadline=time.monotonic()+10
while not end.exists() and time.monotonic()<deadline:
 if start.exists():
  s=socket.socket(); s.settimeout(.2)
  try: s.connect(('127.0.0.1',${server.port})); raise SystemExit('offline process gained network')
  except OSError: failures+=1
  finally: s.close()
 time.sleep(.05)
assert end.exists() and failures>=2
assert os.readlink('/proc/self/ns/net')==before
print('offline-during-online',failures)`;

      pending = run("bash", { command: `python3 - <<'PY'\n${probe}\nPY` }, controller.signal);

      for (let count = 0; count < 100; count++) {
        if (
          await access(join(project, "offline-ready")).then(
            () => true,
            () => false,
          )
        )
          break;

        await Bun.sleep(25);
      }

      await access(join(project, "offline-ready"));

      const online = await scoped({
        ...action("bash", {
          command: `touch online-start; curl -fsS http://127.0.0.1:${server.port}/; sleep 1; touch online-end`,
        }),
        sandbox: { network: "host" },
      });

      expect(JSON.stringify(online.content)).toContain("network-proof");

      const offline = await pending;

      expect(offline.isError).not.toBe(true);
      expect(JSON.stringify(offline.content)).toContain("offline-during-online");
    } finally {
      controller.abort();
      await pending?.catch(() => {});

      server.stop(true);
      await Promise.all(
        ["offline-ready", "online-start", "online-end"].map((file) =>
          rm(join(project, file), { force: true }),
        ),
      );
    }

  },

  15000,
);
nativeTest(
  "reviewed executable search paths mount tools read-only without exposing their parent",
  async () => {
    const tools = join(fixture, "test-bin");

    await mkdir(tools);
    await writeFile(join(tools, "approval-test-tool"), "#!/bin/sh\nprintf runtime-tool", {
      mode: 0o755,
    });

    const output = await scoped({
      ...action("bash", {
        command: `approval-test-tool; test ! -w '${tools}/approval-test-tool'; test ! -e '${fixture}/shared-input.txt'`,
      }),
      sandbox: { executableSearchPaths: [tools] },
    });

    expect(JSON.stringify(output.content)).toContain("runtime-tool");
  },
);
nativeTest("execution, output and temporary storage limits are actually applied", async () => {
  const limitRequest = {
    ...action("bash", { command: "df -B1 --output=size /tmp | tail -1" }),
    sandbox: { limits: { tmpBytes: 4194304 } },
  };

  await expect(scoped(limitRequest)).rejects.toThrow("cannot limit a persistent disk-backed /tmp");

  const tmp = await executeIsolated(
    limitRequest,
    await validateWorkspace(project, native, [], limitRequest.sandbox),
    native,
  );

  expect(JSON.stringify(tmp.content)).toContain("4194304");
  await expect(
    scoped({
      ...action("bash", { command: "sleep 5" }),
      sandbox: { limits: { executionTimeoutMs: 1000 } },
    }),
  ).rejects.toThrow("technical execution limit");
  await expect(
    scoped({
      ...action("bash", { command: "printf '%05000d' 0" }),
      sandbox: { limits: { maxOutputBytes: 2048 } },
    }),
  ).rejects.toThrow("output limit");
});

nativeTest(
  "private /tmp files persist across actions without exposing host files or other sessions",
  async () => {
    const guestFile = join(fixture, "private-temp-file.txt");

    await writeFile(guestFile, "host-only");
    await run("write", { path: guestFile, content: "sandbox-only" });
    expect(JSON.stringify((await run("read", { path: guestFile })).content)).toContain(
      "sandbox-only",
    );
    await run("edit", {
      path: guestFile,
      edits: [{ oldText: "sandbox-only", newText: "edited-temporary" }],
    });
    expect(
      JSON.stringify(
        (
          await run("bash", {
            command: `cat '${guestFile}'; printf '#!/bin/sh\nprintf temp-script' > /tmp/run-script; chmod +x /tmp/run-script; printf ephemeral-home > /tmp/home/runtime-file`,
          })
        ).content,
      ),
    ).toContain("edited-temporary");
    expect(
      JSON.stringify(
        (await run("bash", { command: "/tmp/run-script; test ! -e /tmp/home/runtime-file" }))
          .content,
      ),
    ).toContain("temp-script");
    expect(await readFile(guestFile, "utf8")).toBe("host-only");

    const other = await mkdtemp(join(fixture, "other-session-"));
    const workspace = await validateWorkspace(project, native, [], undefined, other);
    const output = await executeIsolated(
      action("bash", {
        command: `test ! -e '${guestFile}' && test ! -e /tmp/run-script && printf session-separated`,
      }),
      workspace,
      native,
    );

    expect(JSON.stringify(output.content)).toContain("session-separated");
  },
);

nativeTest(
  "temporary grants restore existing private files and leave newly created siblings intact",
  async () => {
    const external = join(fixture, "temporary-grant.txt");

    await writeFile(external, "external-source");
    await run("write", { path: external, content: "private-original" });

    const request = {
      ...action("bash", {
        command: `cat '${external}'; printf created-sibling > '${join(fixture, "created-sibling")}'`,
      }),
      sandbox: { paths: [{ path: external, access: "read" as const }] },
    };

    expect(JSON.stringify((await scoped(request)).content)).toContain("external-source");
    expect(JSON.stringify((await run("read", { path: external })).content)).toContain(
      "private-original",
    );
    expect(
      JSON.stringify((await run("read", { path: join(fixture, "created-sibling") })).content),
    ).toContain("created-sibling");
    expect(await readFile(external, "utf8")).toBe("external-source");
  },
);

nativeTest(
  "hardlinks within private /tmp are allowed, while external aliases are rejected",
  async () => {
    await run("write", { path: "/tmp/temp-link-source", content: "linked-value" });
    await run("bash", {
      command: "ln /tmp/temp-link-source /tmp/temp-link; ln -s /tmp/temp-link project-temp-symlink",
    });
    expect(JSON.stringify((await run("read", { path: "/tmp/temp-link" })).content)).toContain(
      "linked-value",
    );
    expect(JSON.stringify((await run("read", { path: "project-temp-symlink" })).content)).toContain(
      "linked-value",
    );
    await run("bash", { command: "rm /tmp/temp-link /tmp/temp-link-source project-temp-symlink" });

    const external = join(fixture, "external-temp-link");
    const alias = join(privateTmp, "external-alias");

    await writeFile(external, "external-value");
    await link(external, alias);

    try {
      await expect(validateWorkspace(project, native, [], undefined, privateTmp)).rejects.toThrow(
        "outside its exposed boundary",
      );
    } finally {
      await rm(alias);
      await rm(external);
    }

    await expect(
      validateWorkspace(
        project,
        native,
        [],
        { paths: [{ path: privateTmp, access: "read" }] },
        privateTmp,
      ),
    ).rejects.toThrow("private sandbox temporary storage");
  },
);

test("temporary path mapping preserves nested workspace mounts and mounts private storage for Docker", () => {
  const workspace = {
    path: "/tmp/project",
    cwd: "/tmp/project",
    bindings: ["/tmp/project"],
    masked: [],
    temporaryDirectory: "/private/session-tmp",
  };

  expect(sandboxHostPath(workspace, "/tmp/fixture")).toBe("/private/session-tmp/fixture");
  expect(sandboxHostPath(workspace, "fixture")).toBe("/tmp/project/fixture");

  const config: SandboxConfig = {
    backend: "docker",
    dockerExecutable: "/usr/bin/docker",
    image: `sha256:${"a".repeat(64)}`,
  };
  const args = sandboxArguments(workspace, config, "test");

  expect(args).toContain("type=bind,src=/private/session-tmp,dst=/tmp,bind-recursive=disabled");
  expect(args).toContain(
    `/tmp/home:rw,nosuid,nodev,size=268435456,mode=0700,uid=${process.getuid?.() ?? 501},gid=${process.getgid?.() ?? 20}`,
  );
  expect(args.some((arg) => arg.startsWith("/tmp:"))).toBe(false);
  expect(() =>
    sandboxArguments(workspace, config, "test", { limits: { tmpBytes: 4194304 } }),
  ).toThrow("cannot limit");
});

nativeTest(
  "expansions cannot expose protected storage or writable aliases of read-only inputs",
  async () => {
    const privateDir = join(fixture, "private-approval");

    await mkdir(privateDir);

    const request = { paths: [{ path: privateDir, access: "read" as const }] };

    await expect(validateWorkspace(project, native, [privateDir], request)).rejects.toThrow(
      "protected",
    );
    await expect(
      validateWorkspace(project, native, [], {
        paths: [{ path: process.env.HOME!, access: "read" }],
      }),
    ).rejects.toThrow("whole home");
    await expect(
      validateWorkspace(project, native, [], { limits: { memoryMiB: 2048 } }),
    ).rejects.toThrow("Docker backend");

    const writable = join(project, "write-alias.txt");

    await writeFile(writable, "unchanged");

    const readonly = join(fixture, "read-alias.txt");

    await link(writable, readonly);

    try {
      await expect(
        validateWorkspace(project, native, [], { paths: [{ path: readonly, access: "read" }] }),
      ).rejects.toThrow("read-only grant");
    } finally {
      await rm(writable);
      await rm(readonly);
    }

  },
);
test("Docker sandbox arguments apply reviewed resource, environment, mount and network changes", () => {
  const c: SandboxConfig = {
    backend: "docker",
    dockerExecutable: "/usr/bin/docker",
    image: `sha256:${"a".repeat(64)}`,
  };
  const args = sandboxArguments(
    {
      path: "/project",
      cwd: "/project/src",
      bindings: ["/project", "/shared"],
      readOnlyBindings: ["/shared"],
      masked: [],
    },
    c,
    "test",
    {
      network: "host",
      environment: { MODE: "test" },
      limits: { memoryMiB: 2048, cpus: 4, pids: 256, tmpBytes: 536870912 },
    },
  );

  expect(args[args.indexOf("--network") + 1]).toBe("host");
  expect(args[args.indexOf("--memory") + 1]).toBe("2048m");
  expect(args[args.indexOf("--cpus") + 1]).toBe("4");
  expect(args[args.indexOf("--pids-limit") + 1]).toBe("256");
  expect(args).toContain("MODE=test");
  expect(args).toContain("type=bind,src=/shared,dst=/shared,bind-recursive=disabled,readonly");
});

nativeTest("real isolated writes, reads, edits, and ls persist only in the project", async () => {
  await run("write", { path: "allowed.txt", content: "before" });
  await run("edit", { path: "allowed.txt", edits: [{ oldText: "before", newText: "after" }] });
  expect(await readFile(join(project, "allowed.txt"), "utf8")).toBe("after");
  expect(JSON.stringify((await run("read", { path: "allowed.txt" })).content)).toContain("after");
  expect(JSON.stringify((await run("ls", { path: ".", limit: 100 })).content)).toContain(
    "allowed.txt",
  );
});

nativeTest("host secrets, environment, namespaces, and runner writes stay isolated", async () => {
  const secret = join(fixture, "host-secret.txt");

  await writeFile(secret, "test-only-secret");
  process.env.PI_TEST_HOST_SECRET = "test-only-environment-value";

  try {
    const result = await run("bash", {
      command: `test ! -e '${secret}' && test -z "\${PI_TEST_HOST_SECRET+x}" && test ! -w /executor/runner && printf contained`,
    });

    expect(JSON.stringify(result.content)).toContain("contained");

    const resultNs = await run("bash", {
      command: "readlink /proc/self/ns/net; readlink /proc/self/ns/pid",
    });
    const text = JSON.stringify(resultNs.content);
    const hostNetLink = await import("node:fs/promises").then((fs) =>
      fs.readlink("/proc/self/ns/net"),
    );
    const hostPidLink = await import("node:fs/promises").then((fs) =>
      fs.readlink("/proc/self/ns/pid"),
    );

    expect(text).not.toContain(hostNetLink);
    expect(text).not.toContain(hostPidLink);
  } finally {
    delete process.env.PI_TEST_HOST_SECRET;
  }

});

nativeTest("project-internal build hardlinks permit reads and edits", async () => {
  const artifact = join(project, "parser.wasm");
  const deps = join(project, "deps");

  await mkdir(deps);

  const alias = join(deps, "parser.wasm");

  await writeFile(artifact, "build-output");
  await link(artifact, alias);

  try {
    expect(JSON.stringify((await run("ls", { path: ".", limit: 100 })).content)).toContain(
      "parser.wasm",
    );
    expect(JSON.stringify((await run("read", { path: "parser.wasm" })).content)).toContain(
      "build-output",
    );
    await run("edit", {
      path: "parser.wasm",
      edits: [{ oldText: "build-output", newText: "updated-output" }],
    });
    expect(await readFile(alias, "utf8")).toBe("updated-output");

    // A file-only view does not expose the second link, so must not be writable.
    const projection = {
      ...native,
      backend: "bwrap",
      workspaceViews: [{ root: project, paths: [artifact] }],
    } as SandboxConfig;

    await expect(validateWorkspace(project, projection, [])).rejects.toThrow(
      "hardlink has aliases outside",
    );
    await expect(validateWorkspace(project, native, [deps])).rejects.toThrow(
      "hardlink has aliases outside",
    );
  } finally {
    await rm(artifact);
    await rm(deps, { recursive: true });
  }

});

nativeTest("escaping symlinks and host hardlinks are rejected before execution", async () => {
  const outside = join(fixture, "outside.txt");

  await writeFile(outside, "private");

  const alias = join(project, "escape");

  await symlink(outside, alias);
  await expect(validateWorkspace(project, native, [])).rejects.toThrow("symlink escapes");
  await rm(alias);
  await link(outside, alias);
  await expect(validateWorkspace(project, native, [])).rejects.toThrow("hardlink");
  await rm(alias);
});

nativeTest("dangling build-cache symlinks do not block unrelated project actions", async () => {
  const broken = join(project, "stale-cache-link");

  await symlink(join(project, "removed-cache-result.json"), broken);

  try {
    // Pi's normal ls omits dangling symlink entries; the operation must still run.
    await run("ls", { path: ".", limit: 100 });
    await run("write", { path: "unrelated.txt", content: "still usable" });
    expect(await readFile(join(project, "unrelated.txt"), "utf8")).toBe("still usable");
  } finally {
    await rm(broken, { force: true });
    await rm(join(project, "unrelated.txt"), { force: true });
  }

});

nativeTest(
  "virtualenv links to mounted system Python permit project reads and stay read-only",
  async () => {
    const cache = join(project, ".zig-cache/wasi-testsuite-venv/bin");

    await mkdir(cache, { recursive: true });

    const python = join(cache, "python3");

    await symlink("/usr/bin/python3", python);

    try {
      expect(JSON.stringify((await run("ls", { path: ".", limit: 100 })).content)).toContain(
        ".zig-cache",
      );

      const result = await run("bash", {
        command:
          'test ! -w .zig-cache/wasi-testsuite-venv/bin/python3 && .zig-cache/wasi-testsuite-venv/bin/python3 -c "print(\"safe-system-python\")"',
      });

      expect(JSON.stringify(result.content)).toContain("safe-system-python");
      await expect(validateWorkspace(project, native, ["/usr/bin/python3"])).rejects.toThrow(
        "symlink escapes",
      );
    } finally {
      await rm(join(project, ".zig-cache"), { recursive: true, force: true });
    }

  },
);
nativeTest("protected descendants are masked instead of exposing credentials", async () => {
  const hidden = join(project, "private");

  await mkdir(hidden);
  await writeFile(join(hidden, "token"), "private");

  const w = await validateWorkspace(project, native, [hidden]);
  const result = await executeIsolated(
    action("bash", { command: "test ! -r private/token && printf hidden" }),
    w,
    native,
  );

  expect(JSON.stringify(result.content)).toContain("hidden");
  await expect(validateWorkspace(hidden, native, [hidden])).rejects.toThrow("inside protected");
  await rm(hidden, { recursive: true });
});

nativeTest(
  "an exact-file projection cannot expose siblings or create persistent root files",
  async () => {
    const publicFile = join(project, "public.txt");

    await writeFile(publicFile, "public");

    const c: SandboxConfig = {
      ...native,
      backend: "bwrap",
      workspaceViews: [{ root: project, paths: [publicFile] }],
    } as SandboxConfig;
    const w = await validateWorkspace(project, c, []);

    expect(w.bindings).toEqual([publicFile]);

    const result = await executeIsolated(
      action("bash", {
        command: "cat public.txt; test ! -e allowed.txt; test ! -w . && printf restricted",
      }),
      w,
      c,
    );

    expect(JSON.stringify(result.content)).toContain("restricted");
    await executeIsolated(action("write", { path: "public.txt", content: "updated" }), w, c);
    await executeIsolated(
      action("edit", { path: "public.txt", edits: [{ oldText: "updated", newText: "edited" }] }),
      w,
      c,
    );
    expect(await readFile(publicFile, "utf8")).toBe("edited");
  },
);
nativeTest("sandbox failure has no unsandboxed fallback", async () => {
  const broken = { ...native, backend: "bwrap", executable: "/bin/false" } as SandboxConfig;
  const request = action("write", { path: "must-not-exist", content: "bad" });

  await expect(
    executeIsolated(request, await validateWorkspace(project, broken, []), broken),
  ).rejects.toThrow("no local fallback");
  await expect(access(join(project, "must-not-exist"))).rejects.toThrow();
});

nativeTest("cancellation kills the isolated process without a late write", async () => {
  const controller = new AbortController();
  const pending = run("bash", { command: "sleep 10; touch cancelled" }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);

  try {
    await expect(pending).rejects.toThrow("cancelled");
  } finally {
    clearTimeout(timer);
  }

  await expect(access(join(project, "cancelled"))).rejects.toThrow();
});

nativeTest("detached descendants cannot write after their action has finished", async () => {
  await run("bash", {
    command: "sh -c 'sleep 0.3; touch escaped-background' </dev/null >/dev/null 2>&1 &",
  });
  await Bun.sleep(500);
  await expect(access(join(project, "escaped-background"))).rejects.toThrow();
});
