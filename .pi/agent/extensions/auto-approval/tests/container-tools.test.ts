import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { prepareCompose } from "../../container-tools/compose.ts";
import type { ContainerReader, ContainerWorkspace } from "../../shared/contracts/containers.ts";
import { strictParameters } from "../tool-catalog.ts";
import { Check } from "typebox/value";

const workspace: ContainerWorkspace = {
  path: "/project",
  cwd: "/project",
  bindings: ["/project"],
  masked: [],
};

function reader(files: Record<string, string>): ContainerReader {
  return async (paths) =>
    paths.map((path) => {
      const name = resolve(workspace.cwd, path);
      const source = files[name];

      return source === undefined
        ? { errorCode: "ENOENT" }
        : { path: name, source, sha256: createHash("sha256").update(source).digest("hex") };
    });
}

test("container tools accept exact argv or batches, never bare shell commands", () => {
  const action = {
    tool: "container_exec",
    goal: "Build",
    justification: "Run the application build",
  };

  expect(Check(strictParameters, { ...action, arguments: { argv: ["version"] } })).toBe(true);
  expect(
    Check(strictParameters, { ...action, arguments: { commands: [["run", "sdk", "true"]] } }),
  ).toBe(true);
  expect(Check(strictParameters, { ...action, arguments: { argv: "docker run sdk" } })).toBe(false);
  expect(
    Check(strictParameters, { ...action, arguments: { argv: ["version"], commands: [["info"]] } }),
  ).toBe(false);
});

test("Compose interpolation uses granted files and literal environment, never the host", async () => {
  const before = process.env.PI_CONTAINER_HOST_SECRET;

  process.env.PI_CONTAINER_HOST_SECRET = "must-not-be-inherited";

  try {
    const parsed = await prepareCompose(
      [["compose", "up", "-d"]],
      workspace,
      { IMAGE: "sdk:literal" },
      reader({
        "/project/.env": "IMAGE=sdk:file\nPORT=8080\n",
        "/project/compose.yaml":
          'services:\n  app:\n    image: ${IMAGE}\n    environment:\n      SECRET: ${PI_CONTAINER_HOST_SECRET:-absent}\n      LITERAL: $$KEEP\n    env_file: [service.env]\n    volumes: ["./data:/app"]\n',
        "/project/service.env": "FROM_FILE=yes\n",
      }),
    );
    const service = (parsed.manifests[0] as any).config.services.app;

    expect(service.image).toBe("sdk:literal");
    expect(service.environment).toEqual({ SECRET: "absent", LITERAL: "$KEEP", FROM_FILE: "yes" });
    expect(service.volumes).toEqual(["/project/data:/app"]);
    expect(service.env_file).toBeUndefined();
    expect(parsed.sources.map((source) => source.path)).toEqual([
      "/project/.env",
      "/project/compose.yaml",
      "/project/service.env",
    ]);
  } finally {
    if (before === undefined) delete process.env.PI_CONTAINER_HOST_SECRET;
    else process.env.PI_CONTAINER_HOST_SECRET = before;
  }
});

test("Compose snapshots reject implicit environment, includes, duplicate YAML and ambiguous merges", async () => {
  for (const source of [
    "services: {app: {image: sdk, environment: [OPENAI_API_KEY]}}",
    "services: {app: {image: sdk, environment: {OPENAI_API_KEY: null}}}",
    "include: [outside.yaml]\nservices: {app: {image: sdk}}",
    "services: {}\nservices: {}",
  ])
    await expect(
      prepareCompose(
        [["compose", "config"]],
        workspace,
        {},
        reader({ "/project/compose.yaml": source }),
      ),
    ).rejects.toThrow();

  await expect(
    prepareCompose(
      [["compose", "-f", "one.yaml", "-f", "two.yaml", "config"]],
      workspace,
      {},
      reader({}),
    ),
  ).rejects.toThrow("flattened");
  expect(
    (await prepareCompose([["compose", "version"]], workspace, {}, reader({}))).manifests,
  ).toEqual({});
});

test("host policy and pre-start/cleanup regressions use only fake engines", () => {
  const child = Bun.spawnSync([
    "/usr/bin/python3",
    "-I",
    "-B",
    resolve(import.meta.dir, "container-policy.test.py"),
  ]);

  expect(child.stderr.toString()).toContain("Ran 14 tests");
  expect(child.exitCode).toBe(0);
});
