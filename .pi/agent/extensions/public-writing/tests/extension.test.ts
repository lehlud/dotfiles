import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import extension, { writingCheckTool } from "../index.ts";
import {
  PUBLIC_WRITING_EDIT_PASS,
  PUBLIC_WRITING_INSTRUCTION,
  RULE_SOURCE,
  WRITING_RULEBOOK,
} from "../rules.ts";
import { documentationCases, README_EDITED, README_ORIGINAL } from "./documentation-fixtures.ts";

test("each projected context receives one current instruction without changing saved messages", async () => {
  const hooks: Record<string, Function> = {};

  extension({
    on: (name: string, callback: Function) => {
      hooks[name] = callback;
    },
  } as any);

  const user = { role: "user", content: "Write the project README.", timestamp: 1 };
  const old = { role: "custom", customType: "public-writing-policy", content: "obsolete" };
  const original = [user, old];
  const result = await hooks.context({ messages: original });
  const policy = result.messages.at(-1);

  expect(original).toEqual([user, old]);
  expect(result.messages[0]).toBe(user);
  expect(policy.display).toBe(false);
  expect(policy.content).toContain("EVERY language");
  expect(policy.content).toContain("The operator sending prompts is NOT that audience");
  expect(policy.content).toContain("approved_action");
  expect(
    result.messages.filter((message: any) => message.customType === old.customType),
  ).toHaveLength(1);
  expect((await hooks.context({ messages: [] })).messages.at(-1).content).toBe(policy.content);
  expect((await hooks.context({ messages: result.messages })).messages).toHaveLength(2);
  expect(Object.keys(hooks)).toEqual(["context"]);
});

test("the receipt binds the exact original-language draft to the frozen rules", async () => {
  for (const text of [
    "Réparation de vélos.",
    "自転車の修理を承ります。",
    "نصلح الدراجات.",
    "велосипеды",
  ]) {
    const args = { text, audience: "public", format: "plain" };

    expect(Check(writingCheckTool.parameters, args)).toBe(true);

    const result = await writingCheckTool.execute(
      "test",
      args,
      undefined,
      undefined,
      undefined as any,
    );

    expect(result.details).toMatchObject({
      checked: true,
      ruleVersion: RULE_SOURCE.version,
      textHash: createHash("sha256").update(text).digest("hex"),
    });
  }
});

test("operator-only text produces a skip receipt", async () => {
  const result = await writingCheckTool.execute(
    "test",
    { text: "Das ist nicht X, das ist Y.", audience: "operator" },
    undefined,
    undefined,
    undefined as any,
  );

  expect(result.details.checked).toBe(false);
  expect(JSON.stringify(result.content)).toContain("skipped");
});

test("malformed, oversized and undeclared inputs are rejected by the tool schema", () => {
  for (const args of [
    { text: "", audience: "public" },
    { text: "x" },
    { text: "x", audience: "all" },
    { text: "x".repeat(20001), audience: "public" },
    { text: "x", audience: "public", network: true },
    { text: "x", audience: "public", context: "x".repeat(2001) },
  ]) {
    expect(Check(writingCheckTool.parameters, args)).toBe(false);
  }
});

test("documentation regressions preserve measurements, quality failures and deployment limits", () => {
  for (const text of [README_ORIGINAL, README_EDITED]) {
    for (const fact of [
      "9 × 7",
      "47,344",
      "512 × 512",
      "238,908-byte ONNX",
      "102,784-byte INT8 TFLite",
      "material",
      "projected",
      "held-out quantization quality gate",
      "rare, large",
    ])
      expect(text).toContain(fact);
  }

  expect(README_EDITED).toContain("lack deployment qualification");
  expect(README_EDITED).toContain("fail the");

  for (const fixture of documentationCases)
    if (fixture.request.tool === "writing_check")
      expect(Check(writingCheckTool.parameters, fixture.request.arguments)).toBe(true);
});

test("standing guidance supplies an edit pass, structural rules and protected factual controls", () => {
  expect(PUBLIC_WRITING_INSTRUCTION.length).toBeLessThanOrEqual(6500);
  expect(WRITING_RULEBOOK.split("\n").every((line) => line.startsWith("- "))).toBe(true);
  expect(WRITING_RULEBOOK).toContain("'X, not Y'");
  expect(WRITING_RULEBOOK).toContain("split-sentence");
  expect(WRITING_RULEBOOK).toContain("one-line closer");
  expect(WRITING_RULEBOOK).toContain("Unpack nested clauses and noun stacks");
  expect(WRITING_RULEBOOK).toContain("familiar combinations and ordinary verbs");
  expect(WRITING_RULEBOOK).toContain("preserve useful repetition");

  for (const url of [
    "https://github.com/marmbiz/humanizer-de",
    "https://github.com/blader/humanizer",
    "https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing",
    "https://de.wikipedia.org/wiki/Wikipedia:Anzeichen_f%C3%BCr_KI-generierte_Inhalte",
    "https://arxiv.org/abs/2610.29162",
  ])
    expect(RULE_SOURCE.references).toContain(url);

  expect(PUBLIC_WRITING_EDIT_PASS).toContain("files");
  expect(PUBLIC_WRITING_EDIT_PASS).toContain("every measurement and qualification");
  expect(PUBLIC_WRITING_EDIT_PASS).toContain("Never remove a warning");
});
