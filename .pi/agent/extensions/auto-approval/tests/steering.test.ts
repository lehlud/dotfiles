import { beforeEach, expect, test } from "bun:test";
import { registerSteering, STEERING_POLICY, STEERING_TYPE } from "../steering.ts";

let hooks: Record<string, Function>, target: string | undefined;
let ctx: any;
const input = (streamingBehavior = "steer", source = "interactive") => ({ text: "Kommentare bitte auf Deutsch", streamingBehavior, source });
const context = () => hooks.context({ messages: [{ role: "user", content: "Kommentare bitte auf Deutsch", timestamp: 1 }] }, ctx);

beforeEach(() => {
  hooks = {}; target = undefined;
  ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Implementiere und prüfe die Snail-Tests." } }] } };
  registerSteering({ on: (name: string, callback: Function) => { hooks[name] = callback; } } as any, () => target);
});

test("live steering retains the original task without rewriting the user's correction", () => {
  hooks.before_agent_start({ prompt: "Implementiere und prüfe die Snail-Tests." }, ctx);
  const correction = input(); hooks.input(correction, ctx);
  const result = context();
  expect(result.messages[0].content).toBe(correction.text);
  expect(result.messages.at(-1).content).toContain("Implementiere und prüfe die Snail-Tests.");
  expect(result.messages.at(-1).content).toContain(STEERING_POLICY);
  expect(correction).toEqual(input());
  hooks.input({ ...input(), text: "Auch die Fehlerpfade testen" }, ctx);
  expect(context().messages.at(-1).content).toContain("Snail-Tests");
});
test("follow-ups, idle input and extension input do not silently become steering", () => {
  for (const event of [input("followUp"), { ...input(), streamingBehavior: undefined }, input("steer", "extension")]) {
    hooks.input(event, ctx); expect(context()).toBeUndefined();
  }
  hooks.input(input("steer", "rpc"), ctx); expect(context()).toBeDefined();
});
test("goals retain their authoritative target without duplicating it in the steering note", () => {
  target = "Original goal target";
  hooks.input(input(), ctx);
  const content = context().messages.at(-1).content;
  expect(content).toContain("active Operator goal"); expect(content).not.toContain(target);
  expect(content).toContain("explicit requests to stop or replace");
  expect(content).toContain("approved_action");
});
test("context reminders are bounded and replace only their own transient messages", () => {
  hooks.before_agent_start({ prompt: '"\n' + "あ".repeat(10000) }, ctx); hooks.input(input(), ctx);
  const messages = [{ role: "custom", customType: STEERING_TYPE, content: "stale" }, { role: "custom", customType: "other", content: "keep" }];
  const original = structuredClone(messages);
  const result = hooks.context({ messages }, ctx);
  expect(result.messages).toHaveLength(2); expect(result.messages[0].content).toBe("keep");
  expect(result.messages[1].content).toContain("excerpt"); expect(result.messages[1].content).not.toContain("stale");
  expect(Buffer.byteLength(result.messages[1].content)).toBeLessThan(17000);
  expect(messages).toEqual(original);
});
test("new tasks and session changes clear the prior steering scope", () => {
  for (const event of ["session_start", "session_tree", "session_shutdown", "agent_settled"]) {
    hooks.input(input(), ctx); expect(context()).toBeDefined();
    hooks[event]({}, ctx); expect(context()).toBeUndefined();
  }
  hooks.input(input(), ctx);
  hooks.before_agent_start({ prompt: "Neue Aufgabe" }, ctx); expect(context()).toBeUndefined();
  hooks.input(input(), ctx); expect(context().messages.at(-1).content).toContain("Neue Aufgabe");
  expect(context().messages.at(-1).content).not.toContain("Snail-Tests");
});
