import { afterAll, beforeAll, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scopeHomeFile as scopedFile } from "../sandbox/home-access.ts";
import {
  validateWorkspace as validate,
  executeIsolated,
  type SandboxConfig,
} from "../isolation.ts";
import { maintenancePaths } from "../maintenance.ts";
import { ProtectedPaths } from "../protected-paths.ts";
import type { Request } from "../../shared/contracts/action.ts";
import { loadSessionConfig } from "../../shared/session/config.ts";
import { pinSecurityConfig } from "../../shared/session/security-config.ts";
import { ModelState } from "../../shared/configuration/model-state.ts";

const root = await mkdtemp(join(tmpdir(), "pi-home-access-"));
const home = join(root, "home");
const agent = join(home, ".pi/agent");
const bin = join(home, ".local/bin");
const native = process.platform === "linux" && Bun.which("bwrap") ? test : test.skip;
let config: Extract<SandboxConfig, { backend: "bwrap" }>;
const scopeHomeFile = (request: Request, cwd: string) => scopedFile(request, cwd, home);

function validateWorkspace(...args: Parameters<typeof validate>) {
  const [cwd, sandbox, protectedPaths, request, temporary, mode] = args;

  return validate(cwd, sandbox, protectedPaths, request, temporary, mode, home);
}

const action = (
  tool: string,
  args: Record<string, unknown>,
  sandbox?: Request["sandbox"],
): Request => ({
  tool,
  arguments: args,
  goal: "Maintain the operator-requested file",
  justification: "Exact fixture-only regression for home access",
  sandbox,
});

beforeAll(async () => {
  await mkdir(agent, { recursive: true });
  await mkdir(bin, { recursive: true });

  const runner = join(root, "runner");
  const build = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    resolve(import.meta.dir, "../runner.ts"),
    "--outfile",
    runner,
  ]);

  if (build.exitCode) throw new Error(build.stderr.toString());

  config = { backend: "bwrap", executable: Bun.which("bwrap")!, runnerExecutable: runner };
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function withHome(run: () => Promise<void>) {
  const previous = process.env.HOME;
  const priorAgent = process.env.PI_CODING_AGENT_DIR;

  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agent;

  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;

    if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgent;
  }
}

native(
  "home needs no device view: exact wrapper reads and edits persist while siblings remain hidden",
  () =>
    withHome(async () => {
      const file = join(bin, "cmatrix");

      await writeFile(file, "docker wrapper");
      await writeFile(join(home, "private-sibling"), "unrelated-private-data");

      const read = await scopeHomeFile(action("read", { path: "~/.local/bin/cmatrix" }), home);
      const scope = await validateWorkspace(home, config, [agent], read.sandbox);

      expect(scope.bindings).toEqual([file]);
      expect(scope.readOnlyBindings).toEqual([file]);

      const alias = join(home, "wrapper-alias");

      await symlink(file, alias);

      const aliased = await scopeHomeFile(action("read", { path: alias }), home);

      expect(aliased.arguments.path).toBe(file);
      expect(aliased.sandbox?.paths).toEqual([{ path: file, access: "read" }]);
      expect(JSON.stringify((await executeIsolated(read, scope, config)).content)).toContain(
        "docker wrapper",
      );

      const edit = await scopeHomeFile(
        action("edit", {
          path: ".local/bin/cmatrix",
          edits: [{ oldText: "docker wrapper", newText: "native wrapper" }],
        }),
        home,
      );

      await executeIsolated(
        edit,
        await validateWorkspace(home, config, [agent], edit.sandbox),
        config,
      );
      expect(await readFile(file, "utf8")).toBe("native wrapper");

      const check = action(
        "bash",
        {
          command:
            "test ! -e private-sibling && test ! -e .pi/agent && printf private-siblings-hidden",
        },
        read.sandbox,
      );

      expect(JSON.stringify((await executeIsolated(check, scope, config)).content)).toContain(
        "private-siblings-hidden",
      );
    }),
);

native("an empty home projection still runs commands and writable private temporary files", () =>
  withHome(async () => {
    const scope = await validateWorkspace(home, config, [agent]);

    expect(scope.bindings).toEqual([]);

    const result = await executeIsolated(
      action("bash", { command: "printf ok > /tmp/proof; cat /tmp/proof; test ! -w ." }),
      scope,
      config,
    );

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("ok");
  }),
);

native("new home-root files and directories are created only during approved execution", () =>
  withHome(async () => {
    const file = join(home, "new-note.txt");
    const write = await scopeHomeFile(
      action("write", { path: "new-note.txt", content: "requested note" }),
      home,
    );
    const scope = await validateWorkspace(home, config, [agent], write.sandbox);

    expect(scope.pendingPaths?.[0].path).toBe(file);
    await expect(access(file)).rejects.toThrow();
    await executeIsolated(write, scope, config);
    expect(await readFile(file, "utf8")).toBe("requested note");

    const directory = join(home, "new-project");
    const run = action(
      "bash",
      { command: `printf created > '${directory}/output.txt'` },
      { paths: [{ path: directory, access: "write", create: "directory" }] },
    );
    const directoryScope = await validateWorkspace(home, config, [agent], run.sandbox);

    await expect(access(directory)).rejects.toThrow();
    await executeIsolated(run, directoryScope, config);
    expect(await readFile(join(directory, "output.txt"), "utf8")).toBe("created");
    expect(await readFile(join(home, "private-sibling"), "utf8")).toBe("unrelated-private-data");
  }),
);

native(
  "creation cannot overwrite a late occupant and failed sandbox launches remove empty scaffolding",
  () =>
    withHome(async () => {
      const file = join(home, "late-occupant");
      const write = await scopeHomeFile(
        action("write", { path: file, content: "must not overwrite" }),
        home,
      );
      const scope = await validateWorkspace(home, config, [agent], write.sandbox);

      await writeFile(file, "late-user-data");
      await expect(executeIsolated(write, scope, config)).rejects.toThrow("creation failed");
      expect(await readFile(file, "utf8")).toBe("late-user-data");

      const failure = await scopeHomeFile(
        action("write", { path: join(home, "failed-launch"), content: "never written" }),
        home,
      );
      const failedScope = await validateWorkspace(home, config, [agent], failure.sandbox);

      await expect(
        executeIsolated(failure, failedScope, {
          ...config,
          executable: "/bin/false",
        } as SandboxConfig),
      ).rejects.toThrow("no local fallback");
      await expect(access(join(home, "failed-launch"))).rejects.toThrow();
    }),
);

native("creation pins its existing parent identity and cannot request a writable whole home", () =>
  withHome(async () => {
    const parent = join(home, "creation-parent");

    await mkdir(parent);

    const write = action(
      "write",
      { path: join(parent, "new"), content: "no" },
      { paths: [{ path: join(parent, "new"), access: "write", create: "file" }] },
    );
    const scope = await validateWorkspace(home, config, [agent], write.sandbox);

    await rename(parent, parent + "-old");
    await mkdir(parent);
    await expect(executeIsolated(write, scope, config)).rejects.toThrow("parent changed");
    await expect(access(join(parent, "new"))).rejects.toThrow();
    await expect(
      validateWorkspace(home, config, [agent], { paths: [{ path: home, access: "write" }] }),
    ).rejects.toThrow("whole home");
  }),
);

native(
  "explicit Pi maintenance can edit scoped source and configuration, never auth/session or runtime files",
  () =>
    withHome(async () => {
      const code = join(agent, "extensions/example/index.ts");

      await mkdir(resolve(code, ".."), { recursive: true });
      await writeFile(code, "export const value = 1;\n");

      const protection = new ProtectedPaths();
      const edit = action(
        "edit",
        { path: code, edits: [{ oldText: "value = 1", newText: "value = 2" }] },
        { maintenance: true, paths: [{ path: code, access: "write" }] },
      );

      await expect(
        validateWorkspace(home, config, protection.paths, edit.sandbox, undefined, "scoped"),
      ).rejects.toThrow("protected");

      const immutable = resolve(import.meta.dir, "../reserved-native-runtime");
      const reduced = await maintenancePaths(edit, [...protection.paths, immutable]);

      expect(reduced).toContain(immutable);

      const scope = await validateWorkspace(
        home,
        config,
        reduced,
        edit.sandbox,
        undefined,
        "scoped",
      );

      await executeIsolated(edit, scope, config);
      expect(await readFile(code, "utf8")).toContain("value = 2");

      for (const path of [
        agent,
        join(agent, "auth.json"),
        join(agent, "sessions"),
        process.execPath,
      ]) {
        const denied = action(
          "read",
          { path },
          { maintenance: true, paths: [{ path, access: "read" }] },
        );

        if (path === process.execPath)
          await expect(
            validateWorkspace(
              home,
              config,
              await maintenancePaths(denied, protection.paths),
              denied.sandbox,
              undefined,
              "scoped",
            ),
          ).rejects.toThrow("protected");
        else
          await expect(maintenancePaths(denied, protection.paths)).rejects.toThrow(
            "private agent data",
          );
      }
    }),
);

test("Pi maintenance pins active security configuration while reviewer choices stay live", () =>
  withHome(async () => {
    await writeFile(
      join(agent, "auto-approval.json"),
      JSON.stringify({
        recentUserPrompts: 10,
        requestTimeoutMs: 5000,
        sandbox: { backend: "bwrap" },
      }),
    );
    await writeFile(
      join(agent, "auto-approval.device.json"),
      JSON.stringify({
        sandbox: { executable: config.executable, runnerExecutable: config.runnerExecutable },
      }),
    );

    const ctx = { sessionManager: {} } as any;
    const initial = await loadSessionConfig(ctx);

    pinSecurityConfig(initial);
    await writeFile(join(agent, "auto-approval.json"), "not valid JSON until maintenance finishes");
    new ModelState(agent).saveReviewer({ provider: "synthetic", model: "review", thinking: "off" });

    const active = await loadSessionConfig(ctx);

    expect(active.sandbox).toEqual(initial.sandbox);
    expect(active.reviewer).toEqual({ provider: "synthetic", model: "review", thinking: "off" });
  }));
