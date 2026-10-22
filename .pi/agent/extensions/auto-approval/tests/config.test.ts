import { writeConfigFixture } from "./config-fixture.ts";
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelState } from "../../shared/configuration/model-state.ts";
import { assertSandboxReady, loadConfig, resolveConfig } from "../../shared/configuration/load.ts";
import {
  parseConfig,
  parseLocalConfig,
  type PortableConfig,
} from "../../shared/configuration/schemas.ts";

const portable: PortableConfig = {
  recentUserPrompts: 6,
  requestTimeoutMs: 120000,
  sandbox: { backend: "bwrap" },
};
let directory: string;
let bin: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-config-test-"));
  bin = join(directory, "bin");
  await mkdir(bin);

  for (const name of ["bwrap", "docker"])
    await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  await writeConfigFixture(join(directory, "auto-approval.json"), JSON.stringify(portable));
  new ModelState(directory).saveReviewers([
    { provider: "openai", model: "gpt-6-luna", thinking: "medium" },
  ]);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("same portable config resolves against each device home without adding workspace grants", async () => {
  const snapshot = JSON.stringify(portable);

  for (const home of [join(directory, "device-one"), join(directory, "device-two")]) {
    const config = await resolveConfig(portable, {}, { home, searchPath: bin });

    expect(config.sandbox).toEqual({
      backend: "bwrap",
      executable: await realpath(join(bin, "bwrap")),
      runnerExecutable: join(home, ".local/cache/pi-auto-approval/executor"),
    });
  }

  expect(JSON.stringify(portable)).toBe(snapshot);
});

test("normal project configuration loads without a local file or persistent changes", async () => {
  const before = await readFile(join(directory, "auto-approval.json"), "utf8");
  const config = await loadConfig(directory, { home: directory, searchPath: bin });

  expect(config.reviewers[0].model).toBe("gpt-6-luna");
  expect(await readFile(join(directory, "auto-approval.json"), "utf8")).toBe(before);
  expect((await readdir(directory)).sort()).toEqual(["auto-approval.json", "bin", "state"]);
});

test("saved reviewers are independent of portable settings and an active turn keeps its snapshot", async () => {
  const state = new ModelState(directory);
  const active = state.reviewers();
  const next = [{ provider: "openrouter", model: "vendor/review", thinking: "off" as const }];

  state.saveReviewers(next);
  expect((await loadConfig(directory, { searchPath: bin })).reviewers).toEqual(next);
  expect((await loadConfig(directory, { searchPath: bin, reviewers: active })).reviewers).toEqual(
    active,
  );
  expect(
    JSON.parse(await readFile(join(directory, "auto-approval.json"), "utf8")),
  ).not.toHaveProperty("reviewers");
  await rm(join(state.directory, "reviewers.json"));
  expect((await loadConfig(directory, { searchPath: bin })).reviewers).toEqual([]);
});

test("local paths and restricted views merge without changing shared settings and reload per action", async () => {
  const localPath = join(directory, "auto-approval.device.json");
  const sandbox = {
    executable: "/custom/bwrap",
    runnerExecutable: "/custom/runner",
    workspaceViews: [{ root: directory, paths: [join(directory, "public-file")] }],
  };

  await writeFile(localPath, JSON.stringify({ sandbox }));

  const config = await loadConfig(directory, { searchPath: "" });

  expect(config.sandbox).toEqual({ backend: "bwrap", ...sandbox });
  expect(config.reviewers[0].model).toBe("gpt-6-luna");
  await writeFile(
    localPath,
    JSON.stringify({ sandbox: { ...sandbox, runnerExecutable: "/new/runner" } }),
  );
  expect((await loadConfig(directory, { searchPath: "" })).sandbox).toMatchObject({
    runnerExecutable: "/new/runner",
  });
  expect(JSON.parse(await readFile(join(directory, "auto-approval.json"), "utf8"))).toEqual(
    portable,
  );
});

test("malformed local files and filesystem errors fail closed instead of dropping restrictions", async () => {
  const localPath = join(directory, "auto-approval.device.json");

  for (const contents of [
    "not-json",
    '{"sandbox":{"workspaceViews":"invalid"}}',
    '{"enabled":false}',
  ]) {
    await writeFile(localPath, contents);
    await expect(loadConfig(directory, { searchPath: bin })).rejects.toThrow();
  }

  await rm(localPath);
  await mkdir(localPath);
  await expect(loadConfig(directory, { searchPath: bin })).rejects.toThrow();
  await rm(localPath, { recursive: true });
  await symlink(join(directory, "missing-target.json"), localPath);
  await expect(loadConfig(directory, { searchPath: bin })).rejects.toThrow();
});

test("local schema accepts only absolute device paths and views, never reviewer or gate overrides", () => {
  expect(parseLocalConfig("{}")).toEqual({});

  for (const invalid of [
    { model: "other" },
    { enabled: false },
    { sandbox: { backend: "docker" } },
    { sandbox: { executable: "bwrap" } },
    { sandbox: { runnerExecutable: "~/runner" } },
    { sandbox: { workspaceRoots: ["/"] } },
    { sandbox: { workspaceViews: [{ root: "/home", paths: ["relative"] }] } },
    { apiKey: "not-a-real-key" },
  ]) {
    expect(() => parseLocalConfig(JSON.stringify(invalid))).toThrow();
  }
});

test("previous filename preserves restrictions until the device configuration is renamed", async () => {
  const legacyPath = join(directory, "auto-approval.local.json");
  const local = {
    sandbox: {
      executable: "/custom/bwrap",
      runnerExecutable: "/custom/runner",
      workspaceViews: [{ root: directory, paths: [join(directory, "public-file")] }],
    },
  };

  await writeFile(legacyPath, JSON.stringify(local));
  expect((await loadConfig(directory, { searchPath: "" })).sandbox).toEqual({
    backend: "bwrap",
    ...local.sandbox,
  });
  await writeFile(legacyPath, '{"sandbox":{"workspaceViews":"invalid"}}');
  await expect(loadConfig(directory, { searchPath: bin })).rejects.toThrow();
  await writeFile(join(directory, "auto-approval.device.json"), JSON.stringify(local));
  expect((await loadConfig(directory, { searchPath: "" })).sandbox).toEqual({
    backend: "bwrap",
    ...local.sandbox,
  });
});

test("Docker resolves its program on each device and requires the shared immutable image", async () => {
  const docker = parseConfig(
    JSON.stringify({
      ...portable,
      sandbox: { backend: "docker", image: `sha256:${"a".repeat(64)}` },
    }),
  );

  expect((await resolveConfig(docker, {}, { searchPath: bin })).sandbox).toEqual({
    backend: "docker",
    image: `sha256:${"a".repeat(64)}`,
    dockerExecutable: await realpath(join(bin, "docker")),
  });
  expect(() =>
    parseConfig(JSON.stringify({ ...portable, sandbox: { backend: "docker", image: "latest" } })),
  ).toThrow();
  await expect(
    resolveConfig(docker, { sandbox: { workspaceViews: [] } }, { searchPath: bin }),
  ).rejects.toThrow("incompatible");
  await expect(
    resolveConfig(
      portable,
      { sandbox: { dockerExecutable: "/custom/docker" } },
      { searchPath: bin },
    ),
  ).rejects.toThrow("incompatible");
});

test("relative PATH entries and non-executable candidates do not select project code", async () => {
  await expect(resolveConfig(portable, {}, { searchPath: ".:relative:" })).rejects.toThrow(
    "not found on PATH",
  );
  await rm(join(bin, "bwrap"));
  await writeFile(join(bin, "bwrap"), "not executable", { mode: 0o600 });
  await expect(resolveConfig(portable, {}, { searchPath: bin })).rejects.toThrow(
    "not found on PATH",
  );
});

test("native readiness rejects missing, non-executable and directory executors before review", async () => {
  const runner = join(directory, "runner");
  const config = await resolveConfig(
    portable,
    { sandbox: { runnerExecutable: runner } },
    { searchPath: bin },
  );

  await expect(assertSandboxReady(config)).rejects.toThrow(
    `Sandbox executable unavailable: ${runner}`,
  );
  await writeFile(runner, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  await expect(assertSandboxReady(config)).rejects.toThrow("Restart Pi");
  await rm(runner);
  await mkdir(runner);
  await expect(assertSandboxReady(config)).rejects.toThrow("not a regular file");
  await rm(runner, { recursive: true });
  await writeFile(runner, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await assertSandboxReady(config);
  await rm(join(bin, "bwrap"));
  await expect(assertSandboxReady(config)).rejects.toThrow("Sandbox executable unavailable");
});

test("credential profiles are device-owned, reloadable, uniquely named and absent from portable settings", async () => {
  const profile = {
    name: "service",
    executable: "/usr/bin/service",
    allowedArgv: [[{ literal: "inspect" }]],
    secrets: { SERVICE_TOKEN: { type: "environment" as const, name: "SERVICE_TOKEN" } },
  };

  await writeFile(
    join(directory, "auto-approval.device.json"),
    JSON.stringify({ credentialProfiles: [profile] }),
  );
  expect((await loadConfig(directory, { searchPath: bin })).credentialProfiles).toEqual([profile]);
  expect(() =>
    parseConfig(JSON.stringify({ ...portable, credentialProfiles: [profile] })),
  ).toThrow();
  await writeFile(
    join(directory, "auto-approval.device.json"),
    JSON.stringify({ credentialProfiles: [profile, profile] }),
  );
  await expect(loadConfig(directory, { searchPath: bin })).rejects.toThrow("must be unique");
});
