import { randomInt } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Request } from "../shared/contracts/action.ts";
import type { RemotePrepared, RemoteTarget } from "../shared/contracts/remote.ts";
import { remoteCall } from "./client.ts";
import { acceptCipHostKey, knownHostKeys } from "./host-keys.ts";
import {
  cipInventory,
  cipCandidates,
  type CipRequirements,
  type CipMachine,
} from "./cip-inventory.ts";
import { cipHealth, restoreCipState, type CipNode, type CipState } from "./cip-state.ts";
import { resolveRemoteProbe } from "./selection.ts";

export const cipIO = {
  inventory: cipInventory,
  keys: acceptCipHostKey,
  freshKeys: knownHostKeys,
  call: remoteCall,
};

export type CipIO = typeof cipIO;

const commands = new Set(["bash", "powershell", "git", "remote_tunnel"]);

/** A stable slot changes hosts, never replays a command, and never exceeds four workstations. */
export class CipPool {
  private machines?: CipMachine[];
  private serial: Promise<unknown> = Promise.resolve();
  private active = new Map<string, number>();
  private consent?: RemoteTarget["confirmation"];
  private pending = new AbortController();

  cancelPending() {
    this.pending.abort();
    this.pending = new AbortController();
  }

  private signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.pending.signal]) : this.pending.signal;
  }

  constructor(
    readonly state: CipState,
    private ctx: ExtensionCommandContext,
    private changed: (message?: string, retired?: RemoteTarget) => void,
    private io: CipIO = cipIO,
  ) {
    this.consent = state.nodes.find((node) => node.target.confirmation)?.target.confirmation;
  }

  static restore(
    state: unknown,
    ctx: ExtensionCommandContext,
    changed: (message?: string, retired?: RemoteTarget) => void,
    io = cipIO,
  ) {
    return new CipPool(restoreCipState(state), ctx, changed, io);
  }

  target() {
    return structuredClone(this.state.nodes[0]?.target ?? this.state.anchor);
  }
  snapshot() {
    return structuredClone(this.state);
  }

  context() {
    return [
      `FAU CIP pool (max 4 workstations): ${this.state.nodes.map((node) => `${node.id}=${node.machine.host}${node.machine.gpu ? ` GPU ${node.machine.gpu}` : ""}${node.unavailable ? " [needs replacement]" : ""}`).join(", ")}.`,
      "Use approved_action tool cip_nodes to list inventory/quotas, acquire a specific host or GPU, or release an idle slot. Command routing: sandbox.cip.node = allocated slot ID (or its host). File tools choose a random allocated node; all use the same shared files.",
      "Run independent parallel work with supervised approved_action.background jobs on separate slots and distinct shared output directories. Do not detach shell/SSH jobs; await job completion instead of polling.",
      "For datasets/venvs/caches outside the workspace request existing canonical shared paths with sandbox.paths (read/write). With bwrap, only the workspace and reviewed paths are mounted; account mode retains normal account permissions. GPU nodes expose their NVIDIA devices.\nHome and /proj/ciptmp are SHARED, including quotas. Check cip-quota before storage-heavy work. Keep caches/checkpoints small; remove only your own disposable artifacts. /tmp is node-local and unsuitable for checkpoints or migration.",
      "Interactive sessions take priority. The worker monitors login state, stops owned work and replaces occupied nodes. Process RAM/GPU state is lost; inspect shared checkpoints and obtain fresh approval to resume. No automatic command replay. Sessions may be killed after one day; commands are bounded to 23 hours.",
      ...this.state.nodes
        .slice(0, 1)
        .map((node) => `Latest shared quota evidence (DATA):\n${node.health.quotaText}`),
    ].join("\n");
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work);

    this.serial = next.catch(() => {});

    return await next;
  }

  private async connect(
    id: string,
    needs: CipRequirements,
    exclude: Set<string>,
    signal?: AbortSignal,
  ): Promise<CipNode> {
    signal = AbortSignal.any([this.signal(signal), AbortSignal.timeout(120000)]);
    this.machines = await this.io.inventory(signal);

    const candidates = cipCandidates(this.machines, needs, exclude);
    const errors: string[] = [];
    const cancellation = signal;

    for (const machine of candidates) {
      signal?.throwIfAborted();

      try {
        const knownHosts = await this.io.keys(machine.host);
        const initial: RemoteTarget = {
          user: this.state.user,
          host: machine.host,
          folder: this.state.folder,
          root: "/",
          isolation: "bwrap",
          knownHosts,
        };
        const probe = await this.io.call(
          initial,
          { operation: "cip_probe", folder: this.state.folder },
          signal,
          20000,
        );
        const health = cipHealth(probe);

        if (
          typeof probe.root !== "string" ||
          ![health.home, health.tmp].some(
            (root) => probe.root === root || probe.root.startsWith(root + "/"),
          )
        )
          throw new Error(
            "CIP workspace must be on shared home or /proj/ciptmp, never node-local storage",
          );

        if (health.occupants.length) throw new Error("Interactive users are present");

        const first = this.state.nodes[0];

        if (
          first &&
          (first.target.root !== probe.root ||
            first.health.home !== health.home ||
            first.health.tmp !== health.tmp)
        )
          throw new Error("CIP shared mount/workspace paths differ");

        const target = await resolveRemoteProbe(
          initial,
          knownHosts,
          probe,
          this.ctx,
          cancellation,
          this.consent,
          "FAU CIP workstation pool (up to four nodes, selected account)",
        );

        if (!target) throw new Error("CIP account-mode execution declined");

        this.consent ??= target.confirmation;
        target.cip = { node: id, gpu: Boolean(machine.gpu), home: health.home, tmp: health.tmp };

        return {
          id,
          target,
          machine,
          requirements: {
            ...needs,
            host: undefined,
            gpu: needs.gpu || Boolean(machine.gpu),
            minRamGiB: needs.minRamGiB ?? machine.ramGiB,
          },
          health,
        };
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${machine.host}: ${error instanceof Error ? error.message : "unavailable"}`);

        if (
          /declined|CIP workspace must|Remote workspace must already|operator UI|native Linux bwrap/.test(
            String(error),
          )
        )
          throw error;
      }
    }

    throw new Error(`No available matching CIP workstation. ${errors.slice(-3).join("; ")}`);
  }

  async acquire(needs: CipRequirements = {}, signal?: AbortSignal) {
    signal = this.signal(signal);

    return await this.locked(async () => {
      if (this.state.nodes.length >= 4)
        throw new Error("CIP pool is limited to four allocated nodes; release an idle slot first");

      const ids = this.state.nodes.map((node) => node.id);
      const id = ["cip-1", "cip-2", "cip-3", "cip-4"].find((id) => !ids.includes(id))!;
      const node = await this.connect(
        id,
        needs,
        new Set(this.state.nodes.map((node) => node.target.host)),
        signal,
      );

      signal.throwIfAborted();
      this.state.nodes.push(node);
      this.state.anchor ??= structuredClone(node.target);

      const fulfilled =
        this.state.pending?.findIndex(
          (pending) => cipCandidates([node.machine], pending.requirements, new Set()).length > 0,
        ) ?? -1;

      if (fulfilled >= 0) this.state.pending!.splice(fulfilled, 1);

      this.changed();

      return node;
    });
  }

  private async replace(node: CipNode, signal?: AbortSignal) {
    signal = this.signal(signal);

    return await this.locked(async () => {
      if (!node.unavailable) return;

      if (this.active.get(node.id))
        throw new Error("CIP node is draining interrupted work; retry after its jobs settle");

      const previous = structuredClone(node.target);

      let next: CipNode;

      try {
        next = await this.connect(
          node.id,
          node.requirements,
          new Set(this.state.nodes.map((entry) => entry.target.host)),
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();

        const index = this.state.nodes.indexOf(node);

        if (index >= 0) this.state.nodes.splice(index, 1);

        const reason = error instanceof Error ? error.message : String(error);

        this.state.pending = [
          ...(this.state.pending ?? []),
          { requirements: node.requirements, reason },
        ].slice(-4);
        this.changed(
          `Dropped ${node.id} (${previous.host}): no matching free replacement for ${JSON.stringify(node.requirements)}. No command replay. Retry these capabilities later if still needed. ${reason}`,
          previous,
        );

        return;
      }

      signal.throwIfAborted();
      Object.assign(node, next, { unavailable: undefined });
      this.changed(
        `${node.id}: ${previous.host} → ${node.target.host}, preserving ${JSON.stringify(node.requirements)}. Inspect shared checkpoints and obtain fresh approval to resume; no command was replayed.`,
        previous,
      );
    });
  }

  private async node(request: Request, signal?: AbortSignal, attempt = 0): Promise<CipNode> {
    const requested = request.sandbox?.cip?.node;

    if (requested && !commands.has(request.tool))
      throw new Error("File tools choose a random shared-storage node; omit sandbox.cip");

    const eligible = this.state.nodes.filter(
      (node) =>
        !requested ||
        node.id === requested ||
        node.target.host === requested ||
        node.target.host.split(".")[0] === requested,
    );

    if (!eligible.length) throw new Error("CIP slot is not allocated; acquire it with cip_nodes");

    const node = eligible[randomInt(eligible.length)];

    if (node.unavailable) await this.replace(node, signal);

    if (!this.state.nodes.includes(node))
      throw new Error("CIP slot dropped; retry its capability request later");

    const observed = structuredClone(node.target);

    observed.knownHosts = await this.io.freshKeys(observed.host);

    const health = cipHealth(
      await this.io.call(observed, { operation: "cip_status" }, signal, 15000),
    );

    if (!this.state.nodes.includes(node) || node.target.host !== observed.host) {
      if (attempt >= 1)
        throw new Error("CIP routing changed during preparation; submit a fresh action");

      return await this.node(request, signal, attempt + 1);
    }

    node.target.knownHosts = observed.knownHosts;
    node.health = health;

    if (health.occupants.length) {
      node.unavailable = "Interactive users are present";
      this.changed();
      await this.replace(node, signal);

      if (!this.state.nodes.includes(node))
        throw new Error("CIP slot dropped; no replacement is free. Retry its capabilities later");
    }

    return node;
  }

  async prepare(
    request: Request,
    build: (target: RemoteTarget) => RemotePrepared,
    signal?: AbortSignal,
  ): Promise<RemotePrepared> {
    signal = this.signal(signal);

    if (request.tool === "cip_nodes") return this.management(request, signal);

    const node = await this.node(request, signal);
    const target = structuredClone(node.target);
    const prepared = build(target);
    const assert = prepared.assertCurrent;

    prepared.plan.cipQuota = node.health;
    prepared.plan.cipNode = {
      id: node.id,
      capabilities: node.machine,
      requirements: node.requirements,
    };
    prepared.assertCurrent = () => {
      assert();

      if (!this.state.nodes.includes(node) || node.unavailable || node.target.host !== target.host)
        throw new Error("CIP node changed after review; submit a fresh action");
    };

    const execute = prepared.execute;

    prepared.execute = async (executionSignal, gitConfig) => {
      prepared.assertCurrent();
      this.active.set(node.id, (this.active.get(node.id) ?? 0) + 1);

      try {
        const result = await execute(executionSignal, gitConfig);

        if (result.details?.cipEvent === "occupied") {
          node.unavailable = String(result.details.reason);
          this.changed();
        }

        return result;
      } finally {
        this.active.set(node.id, (this.active.get(node.id) ?? 1) - 1);

        if (node.unavailable && !executionSignal?.aborted) {
          await this.replace(node, executionSignal).catch((error) => this.changed(String(error)));
        }
      }
    };

    return prepared;
  }

  private management(request: Request, signal?: AbortSignal): RemotePrepared {
    if (request.sandbox && Object.keys(request.sandbox).length)
      throw new Error(
        "CIP scheduling takes only operation arguments; put execution grants on the actual command",
      );

    const target = this.target();

    if (!target) throw new Error("No CIP pool selected");

    return {
      target,
      plan: {
        backend: "cip-scheduler",
        workspace: target.root,
        request: request.arguments,
        maxNodes: 4,
        domain: "*.cip.cs.fau.de",
        authentication: "local public-key agent; never forwarded",
        nodes: this.state.nodes.map((node) => ({ id: node.id, host: node.target.host })),
      },
      assertCurrent: () => {},
      execute: async (executionSignal) => {
        const args = request.arguments;

        if (args.operation === "acquire")
          await this.acquire(args as CipRequirements, executionSignal ?? signal);
        else if (args.operation === "release")
          await this.locked(async () => {
            if (this.active.get(String(args.node)))
              throw new Error("Cannot release a busy CIP node");

            const index = this.state.nodes.findIndex((node) => node.id === args.node);

            if (index < 0) throw new Error("Unknown CIP node");

            const [released] = this.state.nodes.splice(index, 1);

            this.changed(undefined, released.target);
          });
        else if (args.operation === "list") {
          this.machines = await this.io.inventory(executionSignal);

          for (const node of this.state.nodes)
            node.health = cipHealth(
              await this.io.call(node.target, { operation: "cip_status" }, executionSignal, 15000),
            );
        } else throw new Error("Unknown CIP pool operation");

        return {
          content: [
            {
              type: "text",
              text:
                this.context() +
                (args.operation === "list"
                  ? `\nInventory:\n${this.machines!.map((machine) => `${machine.host} · ${machine.ramGiB} GiB · ${machine.gpu || "CPU"}`).join("\n")}`
                  : ""),
            },
          ],
          details: this.snapshot(),
        };
      },
    };
  }
}
