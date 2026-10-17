import { expect, test } from "bun:test";
import fastMode, { FAST_MODE_ENTRY } from "../../fast-mode/index.ts";
import { fastPayload } from "../../shared/providers/fast.ts";
import { sessionServices } from "../../shared/session/services.ts";

const openai = { provider: "openai", api: "openai-responses" };
const router = { provider: "openrouter", api: "openai-completions" };

function fixture() {
  const hooks: Record<string, Function> = {};
  const commands: Record<string, any> = {};
  const entries: any[] = [];
  const notices: string[] = [];
  let status: string | undefined;
  const ctx: any = {
    model: openai,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus: (_key: string, value?: string) => {
        status = value;
      },
      notify: (message: string) => notices.push(message),
    },
  };

  fastMode({
    on: (name: string, handler: Function) => {
      hooks[name] = handler;
    },
    registerCommand: (name: string, command: unknown) => {
      commands[name] = command;
    },
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
  } as any);
  hooks.session_start({}, ctx);

  return {
    ctx,
    hooks,
    entries,
    notices,
    status: () => status,
    run: (args = "") => commands.fast.handler(args, ctx),
  };
}

test("fast processing preserves the selected model, tools and operator routing restrictions", () => {
  const payload = {
    model: "selected-model",
    messages: [{ role: "user", content: "Keep my model." }],
    tools: [{ type: "function" }],
    provider: {
      only: ["trusted"],
      ignore: ["other"],
      data_collection: "deny",
      order: ["trusted"],
      sort: "price",
      allow_fallbacks: false,
    },
  };
  const before = structuredClone(payload);
  const fast = fastPayload(payload, router, true)!;

  expect(fast).toEqual({ ...payload, provider: { ...payload.provider, sort: "throughput" } });
  expect(payload).toEqual(before);
  expect(fastPayload(payload, openai, true)).toEqual({ ...payload, service_tier: "priority" });
  expect(
    fastPayload(payload, { provider: "openai-codex", api: "openai-codex-responses" }, true),
  ).toMatchObject({ service_tier: "priority" });
  expect(fastPayload(payload, router, false)).toBeUndefined();
  expect(
    fastPayload(payload, { provider: "unknown", api: "openai-completions" }, true),
  ).toBeUndefined();
});

test("toggle, explicit on/off, status and invalid arguments never enter model context", async () => {
  const state = fixture();

  expect(state.status()).toBeUndefined();
  await state.run("on");
  expect(state.status()).toBe("fast");
  expect(sessionServices(state.ctx).fastMode?.()).toBe(true);
  expect(state.hooks.before_provider_request({ payload: { model: "same" } }, state.ctx)).toEqual({
    model: "same",
    service_tier: "priority",
  });
  await state.run("on");
  await state.run("status");
  await state.run("invalid");
  expect(state.entries).toHaveLength(1);
  await state.run();
  expect(state.status()).toBeUndefined();
  expect(state.hooks.before_provider_request({ payload: {} }, state.ctx)).toBeUndefined();
  expect(
    state.entries.every((entry) => entry.type === "custom" && entry.customType === FAST_MODE_ENTRY),
  ).toBe(true);
});

test("branch restore and session switching restore their own state and model changes report unsupported routes", async () => {
  const state = fixture();

  await state.run("on");
  state.hooks.session_tree({}, state.ctx);
  expect(state.status()).toBe("fast");
  state.ctx.model = { provider: "anthropic", api: "anthropic-messages" };
  state.hooks.model_select({}, state.ctx);
  expect(state.status()).toBe("fast (unavailable)");
  state.entries.push({
    type: "custom_message",
    customType: FAST_MODE_ENTRY,
    data: { enabled: false },
  });
  state.hooks.session_tree({}, state.ctx);
  expect(sessionServices(state.ctx).fastMode?.()).toBe(true);
  state.entries.length = 0;
  state.hooks.session_start({}, state.ctx);
  expect(sessionServices(state.ctx).fastMode?.()).toBe(false);
  state.hooks.session_shutdown({}, state.ctx);
  expect(sessionServices(state.ctx).fastMode).toBeUndefined();
});

test("independent sessions never share their fast-mode flag", async () => {
  const first = fixture();
  const second = fixture();

  await first.run("on");
  expect(sessionServices(first.ctx).fastMode?.()).toBe(true);
  expect(sessionServices(second.ctx).fastMode?.()).toBe(false);
});
