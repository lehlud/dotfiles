import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerPresentation, observeTool, display } from "../../subagents/presentation.ts";
import subagents from "../../subagents/index.ts";

initTheme("dark", false);

function component(data: any) {
  let renderer: any;

  registerPresentation({
    registerEntryRenderer(_type: string, callback: any) {
      renderer = callback;
    },
  } as any);

  return new CustomEntryComponent(
    {
      type: "custom",
      customType: "subagent-activity",
      data,
      id: "row",
      parentId: null,
      timestamp: "now",
    },
    renderer,
  );
}

test("subagent reports never turn a padded 1000-column header into terminal whitespace", () => {
  const row = component({
    name: "cedar",
    kind: "report",
    title: "Report",
    color: 0,
    body: "#65 and #66 should be accepted together.\n\nValidate both contexts first.\nLAST-EVIDENCE",
  });

  for (const width of [30, 80, 120]) {
    const lines = row.render(width).map(stripTerminalSequences);

    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => !line.trim())).toHaveLength(1); // Host transcript spacer only.
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  }

  expect(row.render(80).join("\n")).not.toContain("LAST-EVIDENCE");
  row.setExpanded(true);

  const expanded = row.render(80).map(stripTerminalSequences);

  expect(expanded.join("\n")).toContain("LAST-EVIDENCE");
  expect(expanded.filter((line) => !line.trim()).length).toBeLessThan(5);
  row.invalidate();
  expect(row.render(80).join("\n")).toContain("LAST-EVIDENCE");
});

test("routine successful tool actions produce neither a feed row nor a spacer; failures remain visible", () => {
  const base = {
    name: "cedar",
    kind: "tool",
    title: "read · Finished",
    color: 0,
    body: "routine read output",
  };
  const hidden = component(base);

  expect(hidden.hasContent()).toBe(false);
  expect(hidden.render(80)).toEqual([]);

  const failed = component({
    ...base,
    isError: true,
    title: "read · Failed",
    body: "Denied: specific safety concern.",
  });

  expect(failed.hasContent()).toBe(true);
  expect(failed.render(80).join("\n")).toContain("specific safety concern");
});

test("confirmed file changes still render native colored diffs with line numbers", () => {
  const records: any[] = [];
  const job: any = { id: "child", name: "cedar" };
  const diff = "-1 const before = 1;\n+1 const after = 1;";

  observeTool((record) => records.push(record), job, 0, {
    type: "tool_execution_end",
    toolName: "approved_action",
    isError: false,
    result: {
      content: [{ type: "text", text: "Approved" }],
      details: {
        approval: {
          decision: "approve",
          action: { tool: "edit", arguments: { path: "sample.ts" } },
        },
        result: { diff },
      },
    },
  });
  expect(records[0]).toMatchObject({ agentId: "child", kind: "tool", isError: false, diff });

  const row = component(records[0]);
  const output = stripTerminalSequences(row.render(80).join("\n"));

  expect(output).toContain("-1 const before = 1;");
  expect(output).toContain("+1 const after = 1;");
  expect(row.render(80).join("\n")).toContain("\x1b[");
});

test("subagent tool summaries do not repeat a full final report unless expanded", () => {
  let tool: any;

  subagents({
    on() {},
    registerEntryRenderer() {},
    registerCommand() {},
    registerTool(value: any) {
      tool = value;
    },
  } as any);

  const result = {
    content: [{ type: "text", text: "FULL-REPORT repeated\n".repeat(100) }],
    details: { name: "cedar", state: "idle" },
  };
  const collapsed = stripTerminalSequences(
    tool.renderResult(result, { expanded: false }, theme).render(80).join("\n"),
  );

  expect(collapsed).toContain("cedar · idle");
  expect(collapsed).not.toContain("FULL-REPORT");
  expect(tool.renderResult(result, { expanded: true }, theme).render(80).join("\n")).toContain(
    "FULL-REPORT",
  );
});

test("the activity table fits narrow terminals without adding rows or leaking controls", () => {
  let factory: any;

  display(
    {
      ui: {
        setStatus() {},
        setWidget(_name: string, value: any) {
          factory = value;
        },
      },
    } as any,
    [
      {
        id: "child",
        name: "cedar",
        state: "running",
        mode: "review",
        task: "Long task ".repeat(40) + "\x1b]0;bad\x07",
      },
    ],
  );

  const rows = factory().render(40);

  expect(rows).toHaveLength(2);
  expect(rows.every((line: string) => visibleWidth(line) <= 40)).toBe(true);
  expect(rows.join("\n")).not.toContain("\x1b]");
});
