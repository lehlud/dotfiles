import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import extension, { writingCheckTool } from "../index.ts";
import { RULE_SOURCE } from "../rules.ts";

test("public instructions load without a fetch or another active tool", async () => {
  const hooks: Record<string, Function> = {};
  extension({ on: (name: string, callback: Function) => { hooks[name] = callback; } } as any);
  const { message } = await hooks.before_agent_start();
  expect(message.display).toBe(false);
  expect(message.content).toContain("EVERY language");
  expect(message.content).toContain("The operator sending prompts is NOT that audience");
  expect(message.content).toContain("approved_action");
  expect(Object.keys(hooks)).toEqual(["before_agent_start"]);
});

test("the receipt binds the exact original-language draft to the frozen rules", async () => {
  for (const text of ["Réparation de vélos.", "自転車の修理を承ります。", "نصلح الدراجات.", "велосипеды"]) {
    const args = { text, audience: "public", format: "plain" };
    expect(Check(writingCheckTool.parameters, args)).toBe(true);
    const result = await writingCheckTool.execute("test", args, undefined, undefined, undefined as any);
    expect(result.details).toMatchObject({ checked: true, ruleVersion: RULE_SOURCE.version, textHash: createHash("sha256").update(text).digest("hex") });
  }
});

test("operator-only text produces a skip receipt", async () => {
  const result = await writingCheckTool.execute("test", { text: "Das ist nicht X, das ist Y.", audience: "operator" }, undefined, undefined, undefined as any);
  expect(result.details.checked).toBe(false);
  expect(JSON.stringify(result.content)).toContain("skipped");
});

test("malformed, oversized and undeclared inputs are rejected by the tool schema", () => {
  for (const args of [{ text: "", audience: "public" }, { text: "x" }, { text: "x", audience: "all" }, { text: "x".repeat(20001), audience: "public" }, { text: "x", audience: "public", network: true }, { text: "x", audience: "public", context: "x".repeat(2001) }]) {
    expect(Check(writingCheckTool.parameters, args)).toBe(false);
  }
});
