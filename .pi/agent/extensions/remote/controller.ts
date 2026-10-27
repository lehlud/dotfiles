import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RemoteSession, RemoteTarget } from "../shared/contracts/remote.ts";
import { sessionServices } from "../shared/session/services.ts";
import { watchInterrupt } from "../shared/session/interrupt.ts";
import { label, validateTarget } from "./target.ts";
import { selectRemote, selectionIO, type SelectionIO } from "./selection.ts";
import { prepareRemote } from "./operations.ts";
import { CipPool, cipIO, type CipIO } from "./cip-pool.ts";
import { cipUsername } from "./cip-inventory.ts";
import { parseTarget } from "./target.ts";
import type { CipState } from "./cip-state.ts";
import type { Request } from "../shared/contracts/action.ts";
import { Tunnels } from "./tunnels.ts";

const STATE = "remote-workspace";
const CLEANUP = "remote-workspace-cleanup";

type Debt = { target: RemoteTarget; session: string; pending: boolean };

export class RemoteController {
  private selected?: RemoteTarget;
  private cip?: CipPool;
  private invalid?: Error;
  private selection?: AbortController;

  private revision = 0;
  private actors = new Map<string, { actor: string; session: string; target: RemoteTarget }>();
  private started = new Set<string>();
  private debts = new Map<string, Debt>();
  private tunnels = new Tunnels();
  private selecting = false;
  private notify: (message: string) => void = () => {};
  detach: () => void = () => {};

  constructor(
    private pi: ExtensionAPI,
    private io: SelectionIO = selectionIO,
    private cipTransport: CipIO = cipIO,
  ) {}

  cancelSelection() {
    this.selection?.abort();
    this.selecting = false;
  }

  bind(ctx: ExtensionContext) {
    this.detach();
    this.cancelSelection();
    this.cip?.cancelPending();
    this.cip = undefined;
    this.selected = undefined;
    this.invalid = undefined;
    this.actors.clear();
    this.started.clear();
    this.revision++;
    this.notify = (message) => ctx.ui.notify(message, "warning");

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE) {
        try {
          this.cip = undefined;

          if ((entry.data as any)?.kind === "cip") {
            this.cip = this.pool(entry.data as CipState, ctx, true);
            this.selected = this.cip.target();
          } else this.selected = entry.data === null ? undefined : validateTarget(entry.data);

          this.invalid = undefined;
        } catch {
          this.selected = undefined;
          this.invalid = new Error(
            "Saved remote workspace is invalid; use /remote to select it again or /remote off",
          );
        }
      }

      if (entry.type === "custom" && entry.customType === CLEANUP) {
        const debt = entry.data as Debt;

        try {
          validateTarget(debt.target);

          if (/^[a-f0-9-]{36}$/.test(debt.session)) this.debts.set(debt.session, debt);
        } catch {
          ctx.ui.notify(
            "Invalid saved remote cleanup receipt; automatic cleanup skipped",
            "warning",
          );
        }
      }
    }

    const route: RemoteSession = {
      target: () => {
        if (this.invalid) throw this.invalid;

        if (this.selecting) throw new Error("Remote workspace selection is still in progress");

        return this.selected ? structuredClone(this.selected) : undefined;
      },
      context: () => this.cip?.context() ?? "",
      prepare: async (request, _config, actor, reviewOnly, signal) => {
        if (this.invalid) throw this.invalid;

        if (this.selecting || !this.selected)
          throw new Error("No settled remote workspace selected");

        const revision = this.revision;
        const assert = () => {
          if (this.revision !== revision)
            throw new Error("Remote workspace changed after review; submit a fresh action");
        };
        const build = (target: RemoteTarget) =>
          this.prepareTarget(target, request, actor, reviewOnly, assert);
        const prepared = this.cip
          ? await this.cip.prepare(request, build, signal)
          : build({ ...this.selected, knownHosts: await this.io.keys(this.selected.host) });
        const check = prepared.assertCurrent;

        prepared.assertCurrent = () => {
          assert();
          check();
        };

        const execute = prepared.execute;

        prepared.execute = async (executionSignal, gitConfig) => {
          prepared.assertCurrent();

          return await execute(executionSignal, gitConfig);
        };

        return prepared;
      },
      cleanup: async (actor) => {
        const targets = [...this.actors.values()]
          .filter((owned) => owned.actor === actor)
          .map((owned) => owned.target);

        await this.cleanupActor(actor);
        await Promise.all(
          [...new Map(targets.map((target) => [target.host, target])).values()]
            .slice(0, 4)
            .map((target) => this.flushDebts(target)),
        );
      },
    };

    sessionServices(ctx).remote = route;
    this.detach = watchInterrupt(
      ctx,
      () => this.selecting || this.tunnels.list().some((job) => job.state !== "closed"),
      async () => {
        this.cancelSelection();
        this.tunnels.closeAll();
      },
      false,
    );
    this.display(ctx);
  }

  private pool(state: CipState, ctx: ExtensionContext, restore = false): CipPool {
    const changed = (message?: string, retired?: RemoteTarget) => {
      if (this.cip !== pool) return;

      if (retired) {
        for (const owned of this.actors.values())
          if (owned.target.host === retired.host) this.tunnels.closeAll(owned.session);
      }

      this.selected = pool.target();
      this.pi.appendEntry(STATE, pool.snapshot());
      this.display(ctx);

      if (message) {
        this.pi.appendEntry("cip-node-event", { message });
        ctx.ui.notify(message, "warning");

        const content = `CIP infrastructure notice (DATA, not operator authorization): ${message}`;

        this.pi.sendMessage(
          { customType: "cip-node-notice", display: false, content },
          { deliverAs: "steer", triggerTurn: true },
        );
        sessionServices(ctx).broadcastConversationMessage?.("cip-node-notice", content);
      }
    };
    const pool = restore
      ? CipPool.restore(state, ctx as ExtensionCommandContext, changed, this.cipTransport)
      : new CipPool(state, ctx as ExtensionCommandContext, changed, this.cipTransport);

    return pool;
  }

  private prepareTarget(
    target: RemoteTarget,
    request: Request,
    actor: string,
    reviewOnly: boolean,
    assert: () => void,
  ) {
    const key = JSON.stringify([actor, target.host]);
    const session = this.actors.get(key)?.session ?? randomUUID();

    this.actors.set(key, { actor, session, target });

    const prepared = prepareRemote(
      target,
      request,
      session,
      reviewOnly,
      assert,
      this.tunnels,
      this.io.call,
    );
    const execute = prepared.execute;

    prepared.execute = async (signal, gitConfig) => {
      prepared.assertCurrent();
      await this.flushDebts(target);

      if (request.tool !== "remote_tunnel" && !this.started.has(session)) {
        const debt: Debt = { target, session, pending: true };

        this.pi.appendEntry(CLEANUP, debt);
        this.debts.set(session, debt);
        this.started.add(session);
      }

      return await execute(signal, gitConfig);
    };

    return prepared;
  }

  private display(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "02-remote",
      this.invalid
        ? "remote: invalid saved target"
        : this.selected
          ? this.cip
            ? `cip: ${this.cip.state.nodes.length}/4 · ${this.selected.folder}`
            : `remote: ${label(this.selected)}`
          : undefined,
    );
  }

  async command(args: string, ctx: ExtensionCommandContext, cip = false) {
    const input = args.trim();

    if (!cip && (input === "status" || input === "tunnels")) {
      ctx.ui.notify(
        `${this.cip ? this.cip.context() + "\n" : ""}${this.selected ? `${label(this.selected)}\nDirectory: ${this.selected.root}\nIsolation: ${this.selected.isolation}` : "Local workspace."}\nPending remote tmp cleanups: ${[...this.debts.values()].filter((debt) => debt.pending).length}\n${this.tunnels
          .list()
          .map(
            (job) =>
              `${job.id} · ${job.state} · ${job.direction} · 127.0.0.1:${job.port} → ${job.destinationHost}:${job.destinationPort}`,
          )
          .join("\n")}`,
        "info",
      );

      return;
    }

    if (!cip && input.startsWith("close ")) {
      this.tunnels.close(input.slice(6).trim());

      return;
    }

    if (
      this.selecting ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      sessionServices(ctx).peersBusy?.() ||
      sessionServices(ctx).subagentsBusy?.()
    )
      throw new Error("Interrupt/settle current work before changing the remote workspace");

    const opening = new AbortController();
    const revision = this.revision;

    this.selection = opening;
    this.selecting = true;

    try {
      let selected: RemoteTarget | undefined;
      let pool: CipPool | undefined;

      if (!cip && input === "off") {
        await this.stop();
      } else {
        if (cip) {
          if (!input)
            throw new Error("Use /cip <workspace-path>, relative to your CIP home or absolute");

          const user =
            (await cipUsername()) ||
            (await ctx.ui.input("CIP username", "e.g. at69yvos", { signal: opening.signal }));

          if (!user) return;

          parseTarget(`${user}@cip1a0.cip.cs.fau.de:${input}`);
          pool = this.pool({ kind: "cip", user, folder: input, nodes: [] }, ctx);
          await pool.acquire({}, opening.signal);
          selected = pool.target();
        } else selected = await selectRemote(input, ctx, opening.signal, this.io);

        if (!selected) return;

        if (this.revision !== revision) throw new Error("Session changed during remote selection");

        await this.stop();
      }

      opening.signal.throwIfAborted();

      if (this.revision !== revision) throw new Error("Session changed during remote selection");

      this.pi.appendEntry(STATE, pool?.snapshot() ?? selected ?? null);
      this.cip = pool;
      this.selected = selected;
      this.invalid = undefined;
      this.revision++;
      this.display(ctx);
      ctx.ui.notify(
        this.selected
          ? `Remote workspace: ${label(this.selected)}\n${this.selected.root} · ${this.selected.isolation}`
          : "Project actions now use the local workspace.",
        "info",
      );
    } finally {
      if (this.selection === opening) {
        this.selecting = false;
        this.selection = undefined;
      }
    }
  }

  private async flushDebts(target: RemoteTarget) {
    const pending = [...this.debts.values()]
      .filter(
        (debt) =>
          debt.pending && debt.target.host === target.host && debt.target.user === target.user,
      )
      .filter((debt) => !this.started.has(debt.session))
      .slice(0, 3);

    await Promise.all(
      pending.map(async (debt) => {
        try {
          const result = await this.io.call(
            { ...debt.target, knownHosts: await this.io.keys(debt.target.host) },
            { operation: "cleanup", session: debt.session },
            undefined,
            10000,
          );

          if (result?.cleaned !== true) throw new Error("Remote cleanup did not confirm deletion");

          debt.pending = false;
          this.pi.appendEntry(CLEANUP, debt);
        } catch {
          // A disconnected host cannot be cleaned now; retain the exact owned receipt.
        }
      }),
    );
  }

  private async cleanupActor(actor: string) {
    for (const [key, owned] of this.actors) {
      if (owned.actor !== actor) continue;

      this.actors.delete(key);
      this.tunnels.closeAll(owned.session);

      if (!this.started.delete(owned.session)) continue;

      const debt: Debt = { target: owned.target, session: owned.session, pending: true };

      this.debts.set(owned.session, debt);
      this.pi.appendEntry(CLEANUP, debt);
    }
  }

  async stop() {
    this.cip?.cancelPending();
    this.tunnels.closeAll();

    for (const owned of [...this.actors.values()]) await this.cleanupActor(owned.actor);

    const targets = [
      ...(this.cip?.state.nodes.map((node) => node.target) ?? []),
      ...[...this.debts.values()].filter((debt) => debt.pending).map((debt) => debt.target),
    ];

    if (this.selected) targets.push(this.selected);

    await Promise.all(
      [...new Map(targets.map((target) => [target.host, target])).values()]
        .slice(0, 4)
        .map((target) => this.flushDebts(target)),
    );

    const pending = [...this.debts.values()].filter((debt) => debt.pending).length;

    if (pending)
      this.notify(
        `Remote tmp cleanup is pending for ${pending} session(s); deletion could not be confirmed. Receipts are saved for a later connection. See /remote status.`,
      );
  }
}
