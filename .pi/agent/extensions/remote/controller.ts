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
import { Tunnels } from "./tunnels.ts";

const STATE = "remote-workspace";
const CLEANUP = "remote-workspace-cleanup";

type Debt = { target: RemoteTarget; session: string; pending: boolean };

export class RemoteController {
  private selected?: RemoteTarget;
  private invalid?: Error;
  private selection?: AbortController;

  private revision = 0;
  private actors = new Map<string, string>();
  private started = new Set<string>();
  private debts = new Map<string, Debt>();
  private tunnels = new Tunnels();
  private selecting = false;
  private notify: (message: string) => void = () => {};
  detach: () => void = () => {};

  constructor(
    private pi: ExtensionAPI,
    private io: SelectionIO = selectionIO,
  ) {}

  cancelSelection() {
    this.selection?.abort();
    this.selecting = false;
  }

  bind(ctx: ExtensionContext) {
    this.detach();
    this.cancelSelection();
    this.selected = undefined;
    this.invalid = undefined;
    this.actors.clear();
    this.started.clear();
    this.revision++;
    this.notify = (message) => ctx.ui.notify(message, "warning");

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE) {
        try {
          this.selected = entry.data === null ? undefined : validateTarget(entry.data);
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
      prepare: (request, _config, actor, reviewOnly) => {
        if (this.invalid) throw this.invalid;

        if (!this.selected) throw new Error("No remote workspace selected");

        const target = structuredClone(this.selected),
          revision = this.revision;
        const session = this.actors.get(actor) ?? randomUUID();

        this.actors.set(actor, session);

        const prepared = prepareRemote(
          target,
          request,
          session,
          reviewOnly,
          () => {
            if (this.revision !== revision)
              throw new Error("Remote workspace changed after review; submit a fresh action");
          },
          this.tunnels,
          this.io.call,
        );
        const execute = prepared.execute;

        prepared.execute = async (signal, gitConfig) => {
          prepared.assertCurrent();
          await this.flushDebts(target);

          if (request.tool !== "remote_tunnel" && !this.started.has(session)) {
            const debt: Debt = { target, session, pending: true };

            // Persist ownership before dispatch so a Pi crash cannot lose the cleanup address.
            this.pi.appendEntry(CLEANUP, debt);
            this.debts.set(session, debt);
            this.started.add(session);
          }

          return await execute(signal, gitConfig);
        };

        return prepared;
      },
      cleanup: async (actor) => {
        await this.cleanupActor(actor);

        if (this.selected) await this.flushDebts(this.selected);
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

  private display(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "02-remote",
      this.invalid
        ? "remote: invalid saved target"
        : this.selected
          ? `remote: ${label(this.selected)}`
          : undefined,
    );
  }

  async command(args: string, ctx: ExtensionCommandContext) {
    const input = args.trim();

    if (input === "status" || input === "tunnels") {
      ctx.ui.notify(
        `${this.selected ? `${label(this.selected)}\nDirectory: ${this.selected.root}\nIsolation: ${this.selected.isolation}` : "Local workspace."}\nPending remote tmp cleanups: ${[...this.debts.values()].filter((debt) => debt.pending).length}\n${this.tunnels
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

    if (input.startsWith("close ")) {
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

      if (input === "off") {
        await this.stop();
      } else {
        selected = await selectRemote(input, ctx, opening.signal, this.io);

        if (!selected) return;

        if (this.revision !== revision) throw new Error("Session changed during remote selection");

        await this.stop();
      }

      opening.signal.throwIfAborted();

      if (this.revision !== revision) throw new Error("Session changed during remote selection");

      this.pi.appendEntry(STATE, selected ?? null);
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
            debt.target,
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
    const session = this.actors.get(actor);

    this.actors.delete(actor);

    if (session) this.tunnels.closeAll(session);

    if (!session || !this.started.delete(session) || !this.selected) return;

    const debt: Debt = { target: structuredClone(this.selected), session, pending: true };

    this.debts.set(session, debt);
    this.pi.appendEntry(CLEANUP, debt);
  }

  async stop() {
    this.tunnels.closeAll();

    for (const actor of [...this.actors.keys()]) await this.cleanupActor(actor);

    if (this.selected) await this.flushDebts(this.selected);

    const pending = [...this.debts.values()].filter((debt) => debt.pending).length;

    if (pending)
      this.notify(
        `Remote tmp cleanup is pending for ${pending} session(s); deletion could not be confirmed. Receipts are saved for a later connection. See /remote status.`,
      );
  }
}
