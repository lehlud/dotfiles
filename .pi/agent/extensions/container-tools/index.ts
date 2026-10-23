import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ContainerAccess,
  ContainerWorkspace,
  ContainerReader,
} from "../shared/contracts/containers.ts";
import { sessionServices } from "../shared/session/services.ts";
import { bridgeCall, discoverBridge, sourceIdentity } from "./bridge.ts";
import { prepareCompose } from "./compose.ts";

export async function prepareContainerJob(
  request: Parameters<ContainerAccess["prepare"]>[0],
  workspace: ContainerWorkspace,
  read: ContainerReader,
) {
  const sandbox = request.sandbox ?? {};

  if (
    sandbox.tools?.length ||
    sandbox.executableSearchPaths?.length ||
    sandbox.gitConfig !== undefined
  )
    throw new Error(
      "Container jobs use the selected image's tools; local bundles, Git identity and host executables are unavailable",
    );

  const bridge = await discoverBridge();
  const commands = (request.arguments.commands ?? [request.arguments.argv]) as string[][];
  const compose = await prepareCompose(commands, workspace, sandbox.environment ?? {}, read);
  const roots = await Promise.all(
    workspace.bindings.map(async (path) => {
      const info = await lstat(path);

      if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
        throw new Error("Container grants require unaliased regular files or directories");

      return {
        path,
        realpath: await realpath(path),
        device: info.dev,
        inode: info.ino,
        mode: info.mode,
      };
    }),
  );
  const payload = {
    job: randomUUID(),
    engine: request.arguments.engine ?? "auto",
    commands,
    workspace: { ...workspace, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
    network: sandbox.network ?? "none",
    limits: sandbox.limits ?? {},
    environment: sandbox.environment ?? {},
    compose: compose.manifests,
  };
  const prepared = await bridgeCall(bridge, { ...payload, operation: "plan" });
  const plan = {
    backend: "lubox-engine",
    program: prepared.program,
    helperSources: prepared.sources,
    requestedCommands: commands,
    jobPlan: prepared.jobPlan,
    project: { cwd: workspace.cwd, roots },
    configurationSources: compose.sources,
    network: payload.network,
    requestedLimits: payload.limits,
    boundary:
      "Only the fixed native engine client receives the private Lubox bridge. No host shell, socket, API credentials or host environment enters a workload. OCI limits cover workload containers, not the shared engine daemon. All owned resources are temporary; images and project writes may persist. No automatic replay.",
  };

  return {
    plan,
    async assertCurrent() {
      if (JSON.stringify(await sourceIdentity()) !== JSON.stringify(bridge.sources))
        throw new Error("Container helper changed during review; obtain fresh approval");

      for (const root of roots) {
        const now = await lstat(root.path);

        if (
          (await realpath(root.path)) !== root.realpath ||
          now.dev !== root.device ||
          now.ino !== root.inode ||
          now.mode !== root.mode
        )
          throw new Error("Container file grant changed during review");
      }

      for (const source of compose.sources) {
        const now = (await read([source.path]))[0];

        if ("errorCode" in now || now.sha256 !== source.sha256)
          throw new Error("Compose inputs changed during review; obtain fresh approval");
      }
    },
    execute(signal?: AbortSignal) {
      return bridgeCall(
        bridge,
        {
          ...payload,
          operation: "execute",
          expectedProgram: prepared.program,
          expectedPlan: prepared.jobPlan,
        },
        signal,
        (sandbox.limits?.executionTimeoutMs ?? 120000) + 90000,
        sandbox.limits?.maxOutputBytes ?? 1048576,
      );
    },
  };
}

export default function containerTools(pi: ExtensionAPI) {
  const bind = (_event: unknown, ctx: Parameters<typeof sessionServices>[0]) => {
    sessionServices(ctx).containers = { prepare: prepareContainerJob };
  };

  pi.on("session_start", bind);
  pi.on("session_tree", bind);
}
