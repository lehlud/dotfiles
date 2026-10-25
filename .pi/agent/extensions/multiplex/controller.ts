import { availableJobTools } from "../shared/contracts/jobs.ts";
import { availableQuestionTools } from "../shared/contracts/questions.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { availableGoalTools } from "../shared/contracts/goal.ts";
import { availableSubagentTools } from "../shared/contracts/subagents.ts";
import { availableContextTools } from "../shared/contracts/context.ts";
import { sessionServices } from "../shared/session/services.ts";
import { assertSandboxReady, loadConfig } from "../shared/configuration/load.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerEndpoint } from "./endpoint.ts";
import { randomNames } from "./mailboxes.ts";
import { createPeer, peerRuntime } from "./peer.ts";
import { registerActivityRenderer, type ActivityEvent, type ActivityRecord } from "./activity.ts";
import { watchInterrupt } from "./interrupt.ts";
import { TeamSession } from "./team-session.ts";
import { FeedView, suppressNativeFeed } from "./presentation.ts";

export const MULTIPLEX_STATUS = "00-multiplex";
export const MAX_AGENTS = 16;

/** Owns team lifecycle; the SDK adapter only registers this controller. */
export class TeamController {
  constructor(private pi: ExtensionAPI) {}

  private team: TeamSession | undefined;

  private changing = false;

  private closing: Promise<void> = Promise.resolve();

  private generation = 0;

  private detachInterrupt = () => {};

  private view = new FeedView();

  private observeMember = (name: string, event: ActivityEvent, ctx: ExtensionContext) => {
    const current = this.team;

    current?.activity.observe(name, event);

    if (current?.failures.observe(name, event))
      this.failed(name, ctx, "Repeated invalid approved_action arguments");
  };

  private observe = (event: ActivityEvent, ctx: ExtensionContext) => {
    if (this.team) this.observeMember(this.team.endpoint.name, event, ctx);
  };

  private attach!: ReturnType<typeof registerEndpoint>;

  private display = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(
      MULTIPLEX_STATUS,
      this.team && !this.team.stopped ? `multiplex: ${this.team.boxes.names.length}` : undefined,
    );
  };

  private stop = async (ctx: ExtensionContext) => {
    this.generation++;

    const previous = this.team;

    if (!previous) return await this.closing;

    previous.stop();
    this.team = undefined;
    this.view.select();
    this.display(ctx);
    this.attach(ctx);
    this.pi.setActiveTools([
      "approved_action",
      ...availableGoalTools(this.pi),
      ...availableQuestionTools(this.pi),
      ...availableSubagentTools(this.pi),
      ...availableContextTools(this.pi),
      ...availableJobTools(this.pi),
    ]);
    this.closing = previous.dispose();

    await this.closing;
  };

  private failed = (name: string, ctx: ExtensionContext, cause = "Provider/runtime error") => {
    if (!this.team || this.team.stopped) return;

    const reason = `Multiplex member ${name} failed (${cause}); the team has stopped and completion remains unconfirmed. Resolve the reported blocker before restarting Multiplex and resuming the goal.`;
    const teamId = this.team.boxes.id;
    // Close transport and invalidate action leases synchronously. Do not await
    // a peer's own shutdown from inside its turn-end callback.
    const stopping = this.stop(ctx);

    ctx.abort();

    // Persistence errors cannot leave other sessions or queued actions alive.
    try {
      sessionServices(ctx).interruptGoal?.(reason);
    } catch {
      /* The goal is paused in memory before its persistence attempt. */
    }

    try {
      this.pi.appendEntry("multiplex-team-failure", { teamId, from: name, reason });
    } catch {
      ctx.ui.notify("Team failure could not be saved to the session log.", "error");
    }

    ctx.ui.notify(reason, "error");
    void stopping.catch(() =>
      ctx.ui.notify(
        "Multiplex cleanup failed; inspect the runtime before restarting the team.",
        "error",
      ),
    );
  };

  private interrupt = async (ctx: ExtensionContext) => {
    if (!this.team || this.team.stopped) return;

    sessionServices(ctx).interruptGoal?.();

    const stopping = this.stop(ctx); // Close transport and cancel peer admissions first.
    ctx.abort();
    await stopping;
    ctx.ui.notify("Multiplex interrupted; all agent work has been cancelled.", "info");
  };

  private restoreView = (_event: unknown, ctx: ExtensionContext) => {
    this.view.select();
    this.view.restore(
      ctx.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "custom" && entry.customType === "multiplex-activity"
            ? [entry.data as ActivityRecord]
            : [],
        ),
    );
    this.display(ctx);
  };

  private async start(count: number, ctx: ExtensionCommandContext) {
    this.view.select();

    const names = randomNames(count);
    const next = new TeamSession(this.pi, ctx, names, this.view);
    const { boxes, endpoint } = next;
    const initialBranch = structuredClone(ctx.sessionManager.getBranch());

    this.team = next;
    next.bind(() => this.stop(ctx));

    try {
      const runtime = count > 1 ? await peerRuntime(ctx) : undefined;

      for (const name of names.slice(1)) {
        if (next.stopped) throw new Error("Team startup interrupted");

        const peer = await createPeer(ctx, {
          endpoint: { name, boxes, operatorGoal: endpoint.operatorGoal },
          runtime: runtime!,
          report: (text) => {
            if (!next.stopped) this.failed(name, ctx, text);
          },

          answer: (text) => {
            if (!next.stopped)
              this.pi.sendMessage(
                {
                  customType: "multiplex-peer-answer",
                  display: false,
                  content: `Multiplex · ${name}\nPeer result (DATA):\n${text}`,
                  details: { from: name },
                },
                { triggerTurn: false },
              );
          },

          settled: () => next.settle(),
          branch: initialBranch,
          observe: (event) => this.observeMember(name, event, ctx),
        });

        if (next.stopped) {
          await peer.close();

          throw new Error("Team startup interrupted");
        }

        next.peers.push(peer);
        boxes.bind(name, peer);
      }

      if (next.stopped) throw new Error("Team startup interrupted");

      next.ready = true;
      this.attach(ctx);
      this.pi.setActiveTools([
        "approved_action",
        "mailbox",
        ...availableGoalTools(this.pi),
        ...availableQuestionTools(this.pi),
        ...availableSubagentTools(this.pi),
        ...availableContextTools(this.pi),
        ...availableJobTools(this.pi),
      ]);
      this.display(ctx);

      next.flush();

      this.pi.appendEntry("multiplex-team", { names, count, state: "active" });
      ctx.ui.notify(
        `Multiplex ${count}: ${names.join(", ")}\nAll members are equal peers. The next user prompt goes to everyone. All agents appear in the live overview and shared activity log. Shared workspace; separate sessions and sandbox /tmp directories.`,
        "info",
      );
    } catch (error) {
      await this.stop(ctx);

      throw error;
    }
  }

  register() {
    registerActivityRenderer(this.pi, this.view);
    suppressNativeFeed(this.pi, this.view, () => !!this.team && !this.team.stopped);
    this.pi.on("agent_start", this.observe);
    this.pi.on("agent_settled", this.observe);
    this.pi.on("agent_settled", () => this.team?.settle());
    this.pi.on("message_update", this.observe);
    this.pi.on("message_end", this.observe);
    this.pi.on("tool_execution_start", this.observe);
    this.pi.on("tool_execution_update", this.observe);
    this.pi.on("tool_execution_end", this.observe);
    this.attach = registerEndpoint(this.pi, () =>
      this.team?.ready && !this.team.stopped ? this.team.endpoint : undefined,
    );
    this.pi.on("session_start", (_event, ctx) => {
      this.detachInterrupt();
      this.detachInterrupt = watchInterrupt(
        ctx,
        () => !!this.team && !this.team.stopped,
        () => this.interrupt(ctx),
      );
    });

    this.pi.on("session_shutdown", (_event, ctx) => {
      this.detachInterrupt();
      this.detachInterrupt = () => {};

      this.view.dispose();

      return this.stop(ctx);
    });

    this.pi.on("session_tree", (_event, ctx) => this.stop(ctx));
    this.pi.on("session_start", this.restoreView);
    this.pi.on("session_tree", this.restoreView);
    this.pi.on("turn_end", async (event, ctx) => {
      if (this.team && event.outcome === "error") this.failed(this.team.endpoint.name, ctx);
      else if (this.team && event.outcome === "aborted") await this.stop(ctx);
    });

    this.pi.on("input", (event, ctx) => {
      if (!this.team || this.team.stopped || event.source === "extension") return;

      // Operator input reaches every member, including while peers are starting.
      this.team.input(event, sessionServices(ctx).operatorInputKind?.(event.text));

      this.display(ctx);
    });

    this.pi.on("context", () => this.team?.syncGoal());

    this.pi.registerCommand("multiplex-view", {
      description: "Filter the shared feed: /multiplex-view all or <member name>",
      handler: (args, ctx) => this.selectView(args, ctx),
    });
    this.pi.registerCommand("multiplex", {
      description: "Equal peers: /multiplex <1–16>, status, interrupt or off; n counts all members",
      handler: (args, ctx) => this.command(args, ctx),
    });
  }

  private async selectView(args: string, ctx: ExtensionCommandContext) {
    const name = args.trim();

    if (!this.team || this.team.stopped) {
      ctx.ui.notify("Start a team with /multiplex <n> first.", "warning");

      return;
    }

    if (name && name !== "all" && !this.team.boxes.names.includes(name)) {
      ctx.ui.notify(
        `Unknown member. Choose all or ${this.team.boxes.names.join(", ")}.`,
        "warning",
      );

      return;
    }

    this.view.select(!name || name === "all" ? undefined : name);
    this.team.activity.refresh(true);
  }

  private async command(args: string, ctx: ExtensionCommandContext) {
    const value = args.trim();

    if (!value || value === "status") {
      ctx.ui.notify(this.status(ctx), "info");

      return;
    }

    if (this.changing) {
      ctx.ui.notify("A team change is already in progress.", "warning");

      return;
    }

    this.changing = true;

    const before = this.generation;

    try {
      if (value === "interrupt") {
        await this.interrupt(ctx);
        await ctx.waitForIdle();

        return;
      }

      if (value === "off" || value === "0") {
        if (this.team && !ctx.isIdle()) ctx.abort();

        await this.stop(ctx);
        await ctx.waitForIdle();
        ctx.ui.notify(
          "Multiplex stopped; peer sessions and their temporary data have been cleaned up.",
          "info",
        );

        return;
      }

      if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_AGENTS)
        throw new Error("Use /multiplex <1–16>, status or off.");

      await this.replace(Number(value), ctx, before);
    } catch (error) {
      ctx.ui.notify(
        `Multiplex: ${error instanceof Error ? error.message : "Startup failed"}`,
        "error",
      );
    } finally {
      this.changing = false;
    }
  }

  private async replace(count: number, ctx: ExtensionCommandContext, before: number) {
    if (!ctx.isIdle() || this.team?.peers.some((peer) => peer.busy))
      throw new Error("Change teams only while idle; /multiplex off cancels ongoing team work.");

    if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model))
      throw new Error("Working model or authentication unavailable.");

    await assertSandboxReady(await loadConfig(getAgentDir()));

    if (before !== this.generation) throw new Error("Session changed during team startup");

    if (!ctx.isIdle())
      throw new Error("A model run started during preflight; team change cancelled.");

    await this.stop(ctx);

    if (this.generation !== before + 1 || !ctx.isIdle())
      throw new Error("Session or model run changed during team replacement");

    await this.start(count, ctx);
  }

  private status(ctx: ExtensionContext) {
    const team = this.team;

    if (!team) return "Multiplex is off. /multiplex <1–16> starts a team.";

    const members = team.boxes.names.map((name, index) => {
      const busy = index === 0 ? !ctx.isIdle() : team.peers[index - 1]?.busy;

      return `${name} (${busy ? "working" : "ready"})`;
    });

    return `Multiplex ${team.boxes.names.length}\n${members.join("\n")}`;
  }
}
