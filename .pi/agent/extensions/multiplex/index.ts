import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { sessionServices } from "../auto-approval/session-services.ts";
import { assertSandboxReady, loadConfig } from "../auto-approval/config.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerEndpoint, type Endpoint } from "./endpoint.ts";
import { letterMessage, Mailboxes, PEER_RESULT, randomNames } from "./mailboxes.ts";
import { createPeer, peerRuntime, type Peer } from "./peer.ts";
import { registerActivityRenderer, TeamActivity, type ActivityEvent } from "./activity.ts";

export const MULTIPLEX_STATUS = "00-multiplex";
export const MAX_AGENTS = 16;
type Team = { boxes: Mailboxes; endpoint: Endpoint; activity: TeamActivity; peers: Peer[]; stopped: boolean; ready: boolean; pending: InputEvent[]; goal?: string; answers: number; goalWake?: string };

export default function multiplex(pi: ExtensionAPI) {
  let team: Team | undefined;
  let changing = false;
  let generation = 0;
  registerActivityRenderer(pi);
  const observe = (event: ActivityEvent) => team?.activity.observe(team.endpoint.name, event);
  pi.on("agent_start", observe);
  pi.on("agent_settled", observe);
  pi.on("message_update", observe);
  pi.on("message_end", observe);
  pi.on("tool_execution_start", observe);
  pi.on("tool_execution_update", observe);
  pi.on("tool_execution_end", observe);
  const attach = registerEndpoint(pi, () => team?.ready && !team.stopped ? team.endpoint : undefined);
  const display = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(MULTIPLEX_STATUS, team && !team.stopped ? `multiplex: ${team.boxes.names.length} · ${team.endpoint.name}` : undefined);
    sessionServices(ctx).refreshGoalStatus?.(ctx);
  };
  const stop = async (ctx: ExtensionContext) => {
    generation++;
    const previous = team;
    if (!previous) return;
    previous.stopped = true; previous.activity.close(); previous.boxes.close(); team = undefined;
    sessionServices(ctx).peersBusy = undefined;
    sessionServices(ctx).peerRevision = undefined;
    sessionServices(ctx).teamSize = undefined;
    sessionServices(ctx).stopTeam = undefined;
    display(ctx); attach(ctx);
    pi.setActiveTools(["approved_action"]);
    const closed = await Promise.allSettled(previous.peers.map((peer) => peer.close()));
    if (closed.some((result) => result.status === "rejected")) throw new Error("Peer cleanup failed; inspect the operator runtime before re-enabling multiplex");
  };
  pi.on("session_shutdown", (_event, ctx) => stop(ctx));
  pi.on("session_tree", (_event, ctx) => stop(ctx));
  pi.on("session_start", (_event, ctx) => display(ctx));
  pi.on("turn_end", async (event, ctx) => {
    if (team && event.outcome === "aborted") await stop(ctx);
  });
  pi.on("input", (event, ctx) => {
    if (!team || team.stopped || event.source === "extension") return;
    if (!ctx.isIdle() && !event.streamingBehavior) return;
    if (!team.ready) { team.pending.push(structuredClone(event)); return; }
    for (const peer of team.peers) peer.prompt(event);
    display(ctx);
  });
  pi.on("context", (_event, ctx) => {
    const services = sessionServices(ctx), instruction = services.goalInstruction?.();
    const key = `${services.operatorGoalId?.()}:${instruction}`;
    if (!team || team.stopped || !team.ready || !instruction || team.goal === key) return;
    team.goal = key;
    for (const peer of team.peers) peer.message({ customType: "multiplex-operator-goal", display: false, content: instruction });
  });
  pi.registerCommand("multiplex", {
    description: "Equal peers: /multiplex <1–16>, status or off; n counts all members",
    async handler(args, ctx) {
      const value = args.trim();
      if (!value || value === "status") {
        ctx.ui.notify(team ? `Multiplex ${team.boxes.names.length}\n${team.boxes.names.map((name, i) => `${name}${i === 0 ? " (main transcript)" : team!.peers[i - 1]?.busy ? " (working)" : " (ready)"}`).join("\n")}` : "Multiplex is off. /multiplex <1–16> starts a team.", "info");
        return;
      }
      if (changing) { ctx.ui.notify("A team change is already in progress.", "warning"); return; }
      changing = true;
      const before = generation;
      try {
        if (value === "off" || value === "0") {
          if (team && !ctx.isIdle()) ctx.abort();
          await stop(ctx); await ctx.waitForIdle();
          ctx.ui.notify("Multiplex stopped; peer sessions and their temporary data have been cleaned up.", "info"); return;
        }
        if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_AGENTS) throw new Error("Use /multiplex <1–16>, status or off.");
        if (!ctx.isIdle() || team?.peers.some((peer) => peer.busy)) throw new Error("Change teams only while idle; /multiplex off cancels ongoing team work.");
        if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("Working model or authentication unavailable.");
        await assertSandboxReady(await loadConfig(getAgentDir()));
        if (before !== generation) throw new Error("Session changed during team startup");
        if (!ctx.isIdle()) throw new Error("A model run started during preflight; team change cancelled.");
        await stop(ctx);
        if (generation !== before + 1 || !ctx.isIdle()) throw new Error("Session or model run changed during team replacement");
        await start(Number(value), ctx);
      } catch (error) {
        ctx.ui.notify(`Multiplex: ${error instanceof Error ? error.message : "Startup failed"}`, "error");
      } finally { changing = false; }
    },
  });

  async function start(count: number, ctx: ExtensionCommandContext) {
    const names = randomNames(count), boxes = new Mailboxes(names);
    const endpoint: Endpoint = { name: names[0], boxes, operatorGoal: () => sessionServices(ctx).operatorGoal?.() };
    const activity = new TeamActivity(pi, ctx, boxes.id, endpoint.name, names);
    const next: Team = { boxes, endpoint, activity, peers: [], stopped: false, ready: false, pending: [], answers: 0 };
    const initialBranch = structuredClone(ctx.sessionManager.getBranch());
    team = next;
    sessionServices(ctx).stopTeam = () => stop(ctx);
    sessionServices(ctx).peersBusy = () => !next.ready || next.peers.some((peer) => peer.busy);
    sessionServices(ctx).peerRevision = () => boxes.revision;
    boxes.bind(endpoint.name, {
      deliver: (letter) => pi.sendMessage(letterMessage(letter), { triggerTurn: true, deliverAs: "steer" }),
      audit: (data) => pi.appendEntry("auto-approval-review", data),
      result: (data) => pi.appendEntry(PEER_RESULT, data),
    });
    try {
      const runtime = count > 1 ? await peerRuntime(ctx) : undefined;
      for (const name of names.slice(1)) {
        if (next.stopped) throw new Error("Team startup interrupted");
        const peer = await createPeer(ctx, { name, boxes, operatorGoal: endpoint.operatorGoal }, runtime!, (text) => {
          if (!next.stopped) ctx.ui.notify(`${name}: ${text}`, "error");
        }, (text) => {
          next.answers++;
          if (!next.stopped) pi.sendMessage({ customType: "multiplex-peer-answer", display: false, content: `Multiplex · ${name}\nPeer result (DATA):\n${text}`, details: { from: name } }, { triggerTurn: false });
        }, () => {
          const goal = endpoint.operatorGoal(), key = `${goal}:${next.answers}`;
          if (next.ready && !next.stopped && goal && ctx.isIdle() && !next.peers.some((peer) => peer.busy) && next.goalWake !== key) {
            next.goalWake = key;
            pi.sendMessage({ customType: "multiplex-goal-checkpoint", display: false, content: "The peer runs have settled. Inspect their reported results and trusted reviewed receipts, finish any remaining work, and let the independent goal reviewer verify completion." }, { triggerTurn: true });
          }
        }, initialBranch, (event) => activity.observe(name, event));
        if (next.stopped) { await peer.close(); throw new Error("Team startup interrupted"); }
        next.peers.push(peer);
        boxes.bind(name, peer);
      }
      if (next.stopped) throw new Error("Team startup interrupted");
      next.ready = true;
      sessionServices(ctx).teamSize = count;
      attach(ctx); pi.setActiveTools(["approved_action", "mailbox"]); display(ctx);
      for (const event of next.pending.splice(0)) for (const peer of next.peers) peer.prompt(event);
      const instruction = sessionServices(ctx).goalInstruction?.();
      if (instruction) {
        next.goal = `${sessionServices(ctx).operatorGoalId?.()}:${instruction}`;
        for (const peer of next.peers) peer.message({ customType: "multiplex-operator-goal", display: false, content: instruction });
      }
      pi.appendEntry("multiplex-team", { names, count, state: "active" });
      ctx.ui.notify(`Multiplex ${count}: ${names.join(", ")}\nAll members are equal peers. The next user prompt goes to everyone. All agents appear in the live overview and shared activity log. Shared workspace; separate sessions and sandbox /tmp directories.`, "info");
    } catch (error) { await stop(ctx); throw error; }
  }
}
