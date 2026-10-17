import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import codeQuality from "../../code-quality/index.ts";
import { CODE_POLICY, CODE_POLICY_TYPE } from "../../code-quality/policy.ts";

function fixture() {
  let context: any;

  codeQuality({
    on: (name: string, hook: unknown) => {
      expect(name).toBe("context");
      context = hook;
    },
  } as any);

  return (messages: unknown[]) => context({ messages }).messages as any[];
}

test("every request receives one hidden current instruction without changing actual messages", () => {
  const apply = fixture();
  const user = { role: "user", content: "Preserve the API and finish the task.", timestamp: 1 };
  const goal = {
    role: "custom",
    customType: "auto-approval-goal-instruction",
    content: "Current goal",
  };
  const original = [user, goal];
  const result = apply(original);

  expect(original).toEqual([user, goal]);
  expect(result[0]).toBe(user);
  expect(result[1]).toBe(goal);
  expect(result.at(-1)).toMatchObject({
    customType: CODE_POLICY_TYPE,
    content: CODE_POLICY,
    display: false,
  });
  expect(apply(result).filter((entry) => entry.customType === CODE_POLICY_TYPE)).toHaveLength(1);
  expect(apply([]).at(-1).content).toBe(CODE_POLICY);
});

test("obsolete instructions are replaced while quoted user text and other policies remain", () => {
  const apply = fixture();
  const user = { role: "user", content: `Quoted DATA: ${CODE_POLICY_TYPE}` };
  const messages = [
    { role: "custom", customType: CODE_POLICY_TYPE, content: "obsolete" },
    user,
    { role: "custom", customType: CODE_POLICY_TYPE, content: "duplicate" },
    { role: "custom", customType: "auto-approval-policy", content: "Permission constraints" },
  ];
  const result = apply(messages);

  expect(result).toHaveLength(3);
  expect(result[0]).toBe(user);
  expect(result[1]).toBe(messages[3]);
  expect(result.at(-1).content).toBe(CODE_POLICY);
});

test("the standing policy covers semantic groups, wrapping, completed blocks and verification", () => {
  for (const rule of [
    "Group statements by purpose",
    "Always put a blank line",
    "completed control-flow block",
    "Do not add blank lines just because a callback",
    "JSON structure closes",
    "multiline control-flow bodies",
    "100 columns",
    "check those explicitly after formatting",
    "wire formats",
    "normal review and sandbox",
  ])
    expect(CODE_POLICY.replace(/\s+/g, " ")).toContain(rule);

});

test("launcher requires code quality and loads it alongside mandatory action approval", async () => {
  const launcher = await readFile(resolve(import.meta.dir, "../../../../../.local/bin/pi"), "utf8");

  expect(launcher).toContain('_code_quality="$HOME/.pi/agent/extensions/code-quality/index.ts"');
  expect(launcher).toContain('"$_recovery" "$_code_quality" "$_fast"; do');
  expect(launcher).toContain('--extension "$_code_quality"');
  expect(launcher).toContain("--no-approve");
  expect(launcher).toContain("--tools approved_action,mailbox");
});
