import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelState, parseReviewers } from "../../shared/configuration/model-state.ts";
import { updateReviewers } from "../../model-selection/reviewers.ts";
import { modelFooter, modelLabel, registerModelFooter } from "../../model-selection/footer.ts";
import { registerModelSelection } from "../../model-selection/index.ts";
import { registerInheritedSelection } from "../../shared/session/model-selection.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { requestVerdict } from "../../shared/review/client.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const primary = { provider: "fixture", model: "working", thinking: "low" } as const;
const fallback = { provider: "openrouter", model: "vendor/model", thinking: "high" } as const;
const directories: string[] = [];

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-selection-"));

  directories.push(directory);

  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function fixture() {
  const hooks = new Map<string, Function[]>();
  const commands: Record<string, any> = {};
  const notices: string[] = [];
  const ctx: any = {
    cwd: "/project",
    model: { provider: primary.provider, id: primary.model, reasoning: true },
    thinkingLevel: primary.thinking,
    isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      find: (provider: string, id: string) =>
        id === "missing" ? undefined : { provider, id, reasoning: id !== "plain" },
      hasConfiguredAuth: () => true,
    },
    ui: { setFooter() {}, notify: (text: string) => notices.push(text) },
  };
  const emit = async (name: string, event: any = {}) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  const pi: any = {
    on(name: string, handler: Function) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: unknown) {
      commands[name] = command;
    },
    setModel: async (model: any) => {
      ctx.model = model;
      await emit("model_select", { source: "set" });

      return true;
    },
    setThinkingLevel: (level: string) => {
      ctx.thinkingLevel = level;
    },
  };

  return {
    pi,
    ctx,
    emit,
    notices,
    command: (args: string) => commands.reviewer.handler(args, ctx),
  };
}

test("atomic preferences retain full model/thinking pairs and independent reviewer order", async () => {
  const state = new ModelState(await temporary());

  expect(state.working()).toBeUndefined();
  expect(state.reviewers()).toEqual([]);
  state.saveWorking(primary);
  state.saveReviewers([primary, fallback]);

  const otherProcess = new ModelState(join(state.directory, "../.."));

  otherProcess.saveWorking(fallback);
  expect(state.working()).toEqual(fallback);
  expect(state.reviewers()).toEqual([primary, fallback]);
  expect((await stat(join(state.directory, "working.json"))).mode & 0o777).toBe(0o600);
  expect(() => state.saveReviewers([])).toThrow();
  expect(() => state.saveReviewers([primary, primary])).toThrow();
  expect(state.reviewers()).toEqual([primary, fallback]);
});

test("malformed and symlinked state fails closed without replacing the target", async () => {
  const state = new ModelState(await temporary());

  state.saveReviewers([primary]);

  const path = join(state.directory, "reviewers.json");

  await writeFile(path, "broken");
  expect(() => state.reviewers()).toThrow();
  expect(() => state.saveReviewers([fallback])).toThrow();
  await rm(path);

  const target = join(state.directory, "private-target");

  await writeFile(target, "keep");
  await symlink(target, path);
  expect(() => state.reviewers()).toThrow("regular file");
  expect(() => state.saveReviewers([primary])).toThrow("regular file");
  expect(await readFile(target, "utf8")).toBe("keep");
});

test("reviewer commands preserve nested model IDs, explicit thinking and fallback priority", () => {
  const { ctx } = fixture();
  const choices = updateReviewers("add openrouter/vendor/model high", [primary], ctx);

  expect(choices).toEqual([primary, fallback]);
  expect(updateReviewers("move 2 1", choices, ctx)).toEqual([fallback, primary]);
  expect(updateReviewers("thinking off 2", choices, ctx)[1].thinking).toBe("off");
  expect(updateReviewers("set fixture/new high", choices, ctx)[1]).toEqual(fallback);
  expect(() => updateReviewers("remove 1", [primary], ctx)).toThrow();
  expect(() => updateReviewers("set fixture/plain high", choices, ctx)).toThrow("unsupported");
  expect(() => updateReviewers("set fixture/missing high", choices, ctx)).toThrow("not found");
  expect(() => updateReviewers("thinking banana", choices, ctx)).toThrow();
  expect(() => parseReviewers(Array(9).fill(fallback))).toThrow();
  expect(choices).toEqual([primary, fallback]);
});

test("busy reviewer changes persist immediately but activate at the next turn", async () => {
  const directory = await temporary();
  const state = new ModelState(directory);

  state.saveReviewers([primary]);

  const app = fixture();

  registerModelSelection(app.pi, directory);
  await app.emit("session_start", { reason: "startup" });
  app.ctx.isIdle = () => false;
  await app.command("set openrouter/vendor/model high");
  expect(state.reviewers()).toEqual([fallback]);
  expect(sessionServices(app.ctx).activeReviewers?.()).toEqual([primary]);
  expect(app.notices.at(-1)).toContain("queued for next turn");
  await app.emit("turn_start");
  expect(sessionServices(app.ctx).activeReviewers?.()).toEqual([fallback]);
  await app.command("remove 1");
  expect(state.reviewers()).toEqual([fallback]);
  app.ctx.thinkingLevel = "high";
  await app.emit("thinking_level_select");
  expect(state.working()).toEqual({ ...primary, thinking: "high" });
  expect(await readFile(join(state.directory, "reviewers.json"), "utf8")).not.toContain("apiKey");
});

test("peer preferences follow their own boundaries and cannot overwrite root defaults", async () => {
  const parent = fixture();
  const child = fixture();
  let desired = [primary as typeof primary | typeof fallback];

  sessionServices(parent.ctx).desiredReviewers = () => desired;
  sessionServices(parent.ctx).workingModel = () => fallback;
  registerInheritedSelection(child.pi, parent.ctx);
  await child.emit("session_start");
  desired = [fallback];
  expect(sessionServices(child.ctx).activeReviewers?.()).toEqual([primary]);
  await child.emit("turn_start");
  expect(sessionServices(child.ctx).activeReviewers?.()).toEqual([fallback]);
  await child.emit("turn_end");
  expect(child.ctx.model.id).toBe(fallback.model);
  expect(child.ctx.thinkingLevel).toBe("high");
});

test("footer places only the active fast flag beside model and reasoning, within terminal width", () => {
  const { ctx } = fixture();
  const entries: any[] = [];

  ctx.sessionManager = {
    getLeafId: () => "leaf",
    getEntries: () => entries,
    getSessionName: () => undefined,
  };
  ctx.getContextUsage = () => ({ percent: 10, contextWindow: 10000 });

  const footer = modelFooter(ctx, {
    getGitBranch: () => "main",
    getExtensionStatuses: () =>
      new Map([
        ["goal", "goal: test"],
        ["fast-mode", "fast"],
      ]),
  } as any);

  expect(modelLabel(ctx)).not.toContain("fast");
  sessionServices(ctx).fastMode = () => true;
  expect(footer.render(100)[1]).toEndWith("fixture) working · low · fast");
  expect(footer.render(100)[2]).toBe("goal: test");
  expect(footer.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
  sessionServices(ctx).fastMode = () => false;
  expect(footer.render(100).join("\n")).not.toContain("fast");
});

test("inline speed replaces the TUI status row without hiding the RPC status signal", async () => {
  const app = fixture();
  let installed = 0;

  app.ctx.ui.setFooter = () => installed++;
  registerModelFooter(app.pi);
  app.ctx.mode = "rpc";
  await app.emit("session_start");
  expect(sessionServices(app.ctx).inlineModelStatus).toBe(false);
  expect(installed).toBe(0);
  app.ctx.mode = "tui";
  await app.emit("session_start");
  expect(sessionServices(app.ctx).inlineModelStatus).toBe(true);
  expect(installed).toBe(1);
});

test("a review in flight keeps its snapshot and a denial never consults newly selected reviewers", async () => {
  const config = { reviewers: [primary], requestTimeoutMs: 1000, recentUserPrompts: 10 };
  const calls: string[] = [];
  const result = requestVerdict(
    config,
    {
      find: (provider, id) =>
        ({ provider, id, reasoning: true, contextWindow: 100000, maxTokens: 10000 }) as any,
      hasConfiguredAuth: () => true,
      streamSimple(model) {
        calls.push(model.id);
        config.reviewers = [fallback as any];

        return {
          result: async () => ({
            role: "assistant",
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  requestId: "snapshot",
                  decision: "deny",
                  reason: "Unsafe operation",
                }),
              },
            ],
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }),
        } as any;
      },
    },
    {
      requestId: "snapshot",
      fingerprint: "fixture",
      text: '{"latestUserPrompt":"Review the action"}',
    },
    { start() {}, finish() {}, failed() {} },
    undefined,
    "Safety review",
  );

  expect((await result).verdict.decision).toBe("deny");
  expect(calls).toEqual(["working"]);
});
