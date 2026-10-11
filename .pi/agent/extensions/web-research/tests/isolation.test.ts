import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, writeFile, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  executeIsolated,
  sandboxArguments,
  validateWorkspace,
} from "../../auto-approval/isolation.ts";
import type { Request } from "../../shared/contracts/action.ts";
import { resolveWebRuntime } from "../runtime.ts";

const nativeTest =
  process.platform === "linux" && Bun.which("bwrap") && Bun.which("python3") ? test : test.skip;
const root = await mkdtemp(join(tmpdir(), "pi-web-isolation-"));
const project = join(root, "project");
const privateTmp = join(root, "tmp");
const dependencies = join(root, "dependencies");
const worker = join(root, "worker.py");
const config = {
  backend: "bwrap" as const,
  executable: Bun.which("bwrap")!,
  runnerExecutable: join(process.env.HOME!, ".local/cache/pi-auto-approval/executor"),
};
beforeAll(async () => {
  for (const path of [project, privateTmp, dependencies]) await mkdir(path);
  await writeFile(
    worker,
    `import json, pathlib, sys
r=json.load(sys.stdin)
assert not pathlib.Path(${JSON.stringify(project)}).exists(), 'Project unexpectedly exposed'
for target in ['/opt/pi-web/dependencies/mutation', '/workspace/mutation']:
    try:
        pathlib.Path(target).write_text('bad')
        raise RuntimeError('Sandbox path unexpectedly writable')
    except PermissionError: pass
    except OSError as e:
        if e.errno != 30: raise
print(json.dumps({'text':'漢'*r['arguments'].get('maxChars',100), 'details':{'net':str(pathlib.Path('/proc/self/ns/net').readlink())}}))
`,
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const request = (args: Record<string, unknown>, network: "host" | "none" = "none"): Request => ({
  tool: "webfetch",
  arguments: args,
  sandbox: { network },
  goal: "Test research",
  justification: "Verify isolated web operation",
});
async function run(action: Request, real = false) {
  const workspace = await validateWorkspace(project, config, [], action.sandbox, privateTmp, "web");
  workspace.webRuntime = real ? await resolveWebRuntime() : { worker, dependencies };
  return executeIsolated(action, workspace, config);
}
nativeTest(
  "long Unicode output bypasses shell truncation and runtime mounts stay read-only",
  async () => {
    const result = await run(request({ url: "https://example.com/", maxChars: 80000 }));
    expect(result.content).toEqual([{ type: "text", text: "漢".repeat(80000) }]);
    expect(await Bun.file(join(dependencies, "mutation")).exists()).toBe(false);
  },
);
nativeTest(
  "web network scope affects only this new sandbox and is absent from the next one",
  async () => {
    const host = await readlink("/proc/self/ns/net");
    const args = { url: "https://example.com/" };
    const offline = await run(request(args));
    const online = await run(request(args, "host"));
    const again = await run(request(args));
    expect(online.details.net).toBe(host);
    expect(offline.details.net).not.toBe(host);
    expect(again.details.net).not.toBe(host);
  },
);
nativeTest("real worker rejects local URLs and executor rejects invalid arguments", async () => {
  const result = await run(request({ url: "http://127.0.0.1/admin" }), true);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("private network");
  await expect(run(request({ url: "file:///etc/passwd" }))).rejects.toThrow(
    "Invalid web executor arguments",
  );
});
test("both sandbox backends bind only worker and dependencies read-only", async () => {
  const workspace = {
    path: "/workspace",
    cwd: "/workspace",
    bindings: [],
    masked: [],
    webRuntime: { worker, dependencies },
  };
  const native = sandboxArguments(workspace, config, "fixture");
  expect(native.join(" ")).toContain(`--ro-bind ${dependencies} /opt/pi-web/dependencies`);
  expect(native.join(" ")).toContain(`--ro-bind ${worker} /opt/pi-web/worker.py`);
  const docker = sandboxArguments(
    workspace,
    { backend: "docker", dockerExecutable: "/usr/bin/docker", image: `sha256:${"a".repeat(64)}` },
    "fixture",
  );
  expect(docker).toContain(
    `type=bind,src=${dependencies},dst=/opt/pi-web/dependencies,bind-recursive=disabled,readonly`,
  );
  expect(docker).toContain("/workspace:ro,nosuid,nodev,noexec,size=16777216");
  expect(native.join(" ")).toContain("--tmpfs /workspace");
  expect(native.join(" ")).not.toContain(`--bind ${project}`);
});
nativeTest(
  "web research ignores stale skill links and inaccessible project scope without exposing home",
  async () => {
    const unsafe = join(project, "outside-link");
    const stale = join(project, "old-wikipedia-skill");
    await symlink(homedir(), unsafe);
    await symlink("/Users/gunter/.agents/skills/avoid-wikipedia-ai-writing-signs/SKILL.md", stale);
    try {
      await expect(validateWorkspace(project, config, [], undefined, privateTmp)).rejects.toThrow(
        "symlink escapes",
      );
      expect((await run(request({ url: "https://example.com/" }))).isError).not.toBe(true);
      const workspace = await validateWorkspace(
        homedir(),
        config,
        [],
        undefined,
        privateTmp,
        "web",
      );
      expect(workspace.bindings).toEqual([]);
      expect(workspace.cwd).toBe("/workspace");
      expect(
        (
          await validateWorkspace(
            join(project, "missing-directory"),
            config,
            [],
            undefined,
            privateTmp,
            "web",
          )
        ).bindings,
      ).toEqual([]);
    } finally {
      await rm(unsafe);
      await rm(stale);
    }
  },
);
nativeTest(
  "web scope still checks private temporary hardlinks and rejects unused file grants",
  async () => {
    const source = join(root, "hardlink-source.txt");
    await writeFile(source, "host data");
    const alias = join(privateTmp, "external-hardlink");
    await link(source, alias);
    try {
      await expect(
        validateWorkspace(project, config, [], undefined, privateTmp, "web"),
      ).rejects.toThrow("hardlink has aliases outside");
    } finally {
      await rm(alias);
    }
    await expect(
      validateWorkspace(
        project,
        config,
        [],
        { paths: [{ path: source, access: "read" }] },
        privateTmp,
        "web",
      ),
    ).rejects.toThrow("uses no project files");
    await expect(
      validateWorkspace(project, config, [], { tools: ["node"] }, privateTmp, "web"),
    ).rejects.toThrow("uses no project files");
    await expect(
      validateWorkspace(
        project,
        config,
        [],
        { executableSearchPaths: [homedir()] },
        privateTmp,
        "web",
      ),
    ).rejects.toThrow("uses no project files");
    await expect(
      validateWorkspace(project, config, [], { limits: { memoryMiB: 64 } }, privateTmp, "web"),
    ).rejects.toThrow("cgroup limits");
  },
);
