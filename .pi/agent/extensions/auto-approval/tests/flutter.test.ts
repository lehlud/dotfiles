import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { resolveLocalTools } from "../local-tools.ts";
import { executeIsolated, validateWorkspace, type SandboxConfig } from "../isolation.ts";
import { assertToolHost } from "../sandbox/tool-host.ts";

const root = await mkdtemp(join(tmpdir(), "pi-flutter-test-"));
const home = join(root, "home");
const project = join(root, "project");
const sdk = join(home, ".local/share/flutter");
const runtime = resolve(import.meta.dir, "../../../../../.local/config/flutter");
const launchers = resolve(runtime, "../../bin");
const bwrap = Bun.which("bwrap");
const nativeTest = process.platform === "linux" && bwrap ? test : test.skip;
let native: SandboxConfig;

beforeAll(async () => {
  await mkdir(join(sdk, "bin/cache/dart-sdk/bin"), { recursive: true });
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await mkdir(project);
  await copyFile("/usr/bin/echo", join(sdk, "bin/cache/dart-sdk/bin/dart"));
  await writeFile(
    join(sdk, "bin/dart"),
    '#!/bin/bash\nexec "$(dirname "$0")/cache/dart-sdk/bin/dart" "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(join(sdk, "bin/cache/marker"), "host-seed");
  await writeFile(
    join(sdk, "bin/flutter"),
    `#!/bin/bash
set -eu
test "$PUB_CACHE" = /tmp/pi-tools/flutter/pub-cache
test "$FLUTTER_SUPPRESS_ANALYTICS" = true
python3 -c 'import os,socket; endpoint=socket.socket(socket.AF_UNIX); endpoint.bind(os.environ["HOME"]+"/dart-perf")'
cat "$(dirname "$0")/cache/marker"
printf private-update > "$(dirname "$0")/cache/marker"
printf '%s\\n' "$@"
`,
    { mode: 0o755 },
  );

  for (const name of ["flutter", "dart"]) {
    const original = await readFile(join(launchers, name), "utf8");
    const traced = original.replace(
      "#!/usr/bin/env bash",
      "#!/usr/bin/env bash\nprintf 'launcher:%s\\n' \"${BASH_SOURCE[0]}\"",
    );

    await writeFile(join(home, ".local/bin", name), traced, { mode: 0o755 });
  }

  await cp(runtime, join(home, ".local/config/flutter"), { recursive: true });

  if (!bwrap || process.platform !== "linux") return;

  const runner = join(root, "runner");
  const built = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    resolve(import.meta.dir, "../runner.ts"),
    "--outfile",
    runner,
  ]);

  if (built.exitCode) throw new Error(built.stderr.toString());

  native = { backend: "bwrap", executable: bwrap, runnerExecutable: runner };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("Flutter and Dart execute the original launchers with a matching native SDK", async () => {
  expect(await resolveLocalTools(["flutter", "dart"], home)).toEqual([
    {
      name: "flutter",
      commandDirectory: join(home, ".local/bin"),
      sources: [
        ...["flutter", "dart"].map((name) => ({
          source: join(home, ".local/bin", name),
          target: join(home, ".local/bin", name),
        })),
        ...["sandbox.sh", "sandbox-install.sh", "sandbox-release.py", "native-runtime.sh"].map(
          (name) => ({
            source: join(home, ".local/config/flutter", name),
            target: join(home, ".local/config/flutter", name),
          }),
        ),
        { source: sdk, target: "/opt/pi-tools/source/flutter/sdk" },
      ],
    },
  ]);

  const dart = join(sdk, "bin/cache/dart-sdk/bin/dart");
  const original = await readFile(dart);

  try {
    await writeFile(dart, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));

    const [tool] = await resolveLocalTools(["flutter"], home);

    expect(tool.sources.some(({ source }) => source === sdk)).toBe(false);
    expect(tool.sources.some(({ source }) => source === join(home, ".local/bin/flutter"))).toBe(
      true,
    );
  } finally {
    await writeFile(dart, original);
  }

});

test("release metadata selects matching stable architecture and rejects substituted paths or hashes", async () => {
  const file = join(root, "manifest.json");
  const entry = {
    hash: "stable",
    dart_sdk_arch: "x64",
    archive: "stable/linux/flutter_linux_1.2.3-stable.tar.xz",
    sha256: "a".repeat(64),
  };
  const select = async (override = {}, arch = "x64") => {
    await writeFile(
      file,
      JSON.stringify({
        current_release: { stable: "stable" },
        releases: [{ ...entry, ...override }],
      }),
    );

    return Bun.spawnSync(["python3", join(runtime, "sandbox-release.py"), file, arch]);
  };

  expect((await select()).exitCode).toBe(0);
  expect((await select({}, "arm64")).exitCode).toBe(0);
  expect((await select({}, "riscv64")).exitCode).not.toBe(0);
  expect((await select({ archive: "../../other.tar.xz" })).exitCode).not.toBe(0);
  expect((await select({ sha256: "invalid" })).exitCode).not.toBe(0);
});

test("Flutter requires a container, without changing the boundary for other tools", async () => {
  const config = { backend: "bwrap" as const, executable: "/bwrap", runnerExecutable: "/runner" };
  const absent = async () => false;

  await expect(assertToolHost(["dart"], config, absent)).rejects.toThrow("require a container");
  await expect(assertToolHost(["flutter"], config, async () => true)).resolves.toBeUndefined();
  await expect(assertToolHost(["node"], config, absent)).resolves.toBeUndefined();
  await expect(
    assertToolHost(
      ["dart"],
      { backend: "docker", image: `sha256:${"a".repeat(64)}`, dockerExecutable: "/docker" },
      absent,
    ),
  ).resolves.toBeUndefined();
});

async function run(command: string, storage: string, seeded = true, enabled = true) {
  await mkdir(storage, { recursive: true });

  const tools = enabled ? await resolveLocalTools(["flutter"], home) : [];

  if (!seeded) {
    for (const tool of tools) tool.sources = tool.sources.filter(({ source }) => source !== sdk);

  }

  const paths = tools.flatMap((tool) =>
    tool.sources.map(({ source: path }) => ({ path, access: "read" as const })),
  );
  const workspace = await validateWorkspace(
    project,
    native,
    [],
    paths.length ? { paths } : undefined,
    storage,
  );

  workspace.localTools = tools;

  return executeIsolated(
    {
      tool: "bash",
      arguments: { command },
      goal: "Validate private Flutter",
      justification: "Disposable local fixture",
    },
    workspace,
    native,
  );
}

nativeTest(
  "native Flutter/Dart use a private persistent SDK copy, with read-only host code and per-action PATH",
  async () => {
    const storage = join(root, "seeded-storage");
    const first = await run(
      `flutter --version; dart native-dart; test ! -w '${sdk}/bin/cache/marker'; ! command -v podman`,
      storage,
    );

    expect(first.isError).not.toBe(true);
    expect(JSON.stringify(first.content)).toContain("host-seed");
    expect(JSON.stringify(first.content)).toContain("native-dart");
    expect(JSON.stringify(first.content)).toContain(`launcher:${home}/.local/bin/flutter`);
    expect(JSON.stringify(first.content)).toContain(`launcher:${home}/.local/bin/dart`);

    const launcher = join(home, ".local/bin/flutter");
    const original = await readFile(launcher, "utf8");

    await writeFile(
      launcher,
      original.replace("set -euo pipefail", "set -euo pipefail\nprintf launcher-updated"),
    );

    const updated = await run("flutter --version", storage);

    expect(JSON.stringify(updated.content)).toContain("launcher-updated");
    expect(JSON.stringify((await run("flutter analyze", storage)).content)).toContain(
      "private-update",
    );
    expect(await readFile(join(sdk, "bin/cache/marker"), "utf8")).toBe("host-seed");
    expect(
      (await run("! command -v flutter && ! command -v dart", storage, true, false)).isError,
    ).not.toBe(true);
    await writeFile(
      join(storage, "pi-tools/flutter/sdk/bin/cache/dart-sdk/bin/dart"),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    );

    const stale = await run("flutter --version", storage);

    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("native Linux Dart runtime");
  },

);

async function mockDownloads(bundle = sdk) {
  const archive = join(project, "flutter.tar.xz");
  const tar = Bun.spawnSync(["tar", "-cJf", archive, "-C", resolve(bundle, ".."), "flutter"]);

  expect(tar.exitCode).toBe(0);

  const manifest = {
    current_release: { stable: "fixture" },
    releases: [
      {
        hash: "fixture",
        dart_sdk_arch: "x64",
        archive: "stable/linux/flutter_linux_1.2.3-stable.tar.xz",
        sha256: createHash("sha256")
          .update(await readFile(archive))
          .digest("hex"),
      },
    ],
  };

  await writeFile(join(project, "releases.json"), JSON.stringify(manifest));
  await mkdir(join(project, "fakebin"), { recursive: true });
  await writeFile(
    join(project, "fakebin/curl"),
    `#!/bin/bash
set -eu
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url="$1" ;;
    -o) shift; output="$1" ;;
  esac

  shift
done

case "$url" in
  https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json)
    cp "$PWD/releases.json" "$output"
    ;;
  https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_1.2.3-stable.tar.xz)
    cp "$PWD/flutter.tar.xz" "$output"
    ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  return manifest;
}

nativeTest(
  "initial setup stays offline unless networking is reviewed and verifies archives before execution",
  async () => {
    const offline = await run("flutter --version", join(root, "offline-storage"), false);

    expect(offline.isError).toBe(true);
    expect(JSON.stringify(offline.content)).toContain("network: true and independent approval");

    const manifest = await mockDownloads();

    const command = 'PATH="$PWD/fakebin:$PATH" flutter --version';
    const installed = await run(command, join(root, "installed-storage"), false);

    expect(installed.isError).not.toBe(true);
    expect(JSON.stringify(installed.content)).toContain("host-seed");

    manifest.releases[0].sha256 = "0".repeat(64);
    await writeFile(join(project, "releases.json"), JSON.stringify(manifest));

    const rejected = await run(command, join(root, "rejected-storage"), false);

    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).not.toContain("host-seed");
  },

);

nativeTest("arm64 setup replaces foreign Dart before executing any Dart binary", async () => {
  const bundle = join(project, "arm-bundle/flutter");
  const cachedDart = join(bundle, "bin/cache/dart-sdk/bin");

  await mkdir(cachedDart, { recursive: true });
  await copyFile("/usr/bin/echo", join(cachedDart, "dart"));
  await writeFile(join(bundle, "bin/cache/engine-dart-sdk.stamp"), "foreign-sdk");
  await writeFile(
    join(bundle, "bin/flutter"),
    `#!/bin/bash
set -eu
sdk="$(dirname "$0")"
if [ ! -f "$sdk/cache/dart-sdk/bin/dart" ]; then
  test ! -f "$sdk/cache/engine-dart-sdk.stamp"
  mkdir -p "$sdk/cache/dart-sdk/bin"
  cp "$PWD/arm-dart" "$sdk/cache/dart-sdk/bin/dart"
  printf 'native-arm64-bootstrap\\n'
fi

printf '%s\\n' "$@"
`,
    { mode: 0o755 },
  );

  const header = Buffer.alloc(64);

  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(header);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(183, 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(64, 52);
  await writeFile(join(project, "arm-dart"), header, { mode: 0o755 });
  await mockDownloads(bundle);
  await writeFile(
    join(project, "fakebin/uname"),
    '#!/bin/bash\nif [ "$1" = -s ]; then echo Linux; else echo aarch64; fi\n',
    { mode: 0o755 },
  );

  const result = await run(
    'PATH="$PWD/fakebin:$PATH" flutter --version',
    join(root, "arm-storage"),
    false,
  );

  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.content)).toContain("native-arm64-bootstrap");
});

