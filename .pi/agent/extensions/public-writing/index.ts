import { createHash } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PUBLIC_WRITING_INSTRUCTION, RULE_SOURCE, WRITING_RULES } from "./rules.ts";

export const writingCheckTool: ToolDefinition<any, any> = {
  name: "writing_check",
  label: "Public writing review",
  description:
    "Independently check newly authored public-facing prose against frozen, language-independent editorial rules. The approval reviewer performs the semantic check: a deny reason contains actionable findings; revise and submit the corrected draft. Check original-language plain text, Markdown or HTML prose, excluding code and required quotes. Operator-only conversation is out of scope. A pass never authorizes writing or publication.",
  parameters: Type.Object(
    {
      text: Type.String({ minLength: 1, maxLength: 20000 }),
      audience: Type.Union([Type.Literal("public"), Type.Literal("operator")]),
      format: Type.Optional(
        Type.Union([Type.Literal("plain"), Type.Literal("markdown"), Type.Literal("html")]),
      ),
      context: Type.Optional(Type.String({ maxLength: 2000 })),
    },
    { additionalProperties: false },
  ),
  async execute(_id, args: any) {
    // No second model call: the exact draft was judged by the mandatory reviewer.
    // This receipt is useful only with the gate's matching approval audit entry.
    const checked = args.audience === "public";

    return {
      content: [
        {
          type: "text",
          text: checked
            ? "Public prose passed the independent contextual style review."
            : "Operator-only text: public writing review skipped.",
        },
      ],
      details: {
        checked,
        ruleVersion: RULE_SOURCE.version,
        ruleCount: WRITING_RULES.length,
        textHash: createHash("sha256").update(args.text).digest("hex"),
      },
    };
  },
};

export default function publicWriting(pi: ExtensionAPI) {
  pi.on("context", (event) => ({
    messages: [
      ...event.messages.filter(
        (entry) => entry.role !== "custom" || entry.customType !== "public-writing-policy",
      ),
      {
        role: "custom",
        customType: "public-writing-policy",
        content: PUBLIC_WRITING_INSTRUCTION,
        display: false,
        timestamp: 0,
      },
    ],
  }));
}
