import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createLsToolDefinition,
  createBashToolDefinition,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  setKeybindings,
  stripTerminalSequences,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createApprovalRenderers } from "../renderers.ts";
import { webTools } from "../../web-research/index.ts";
import { gitTool } from "../git-command.ts";
import { credentialCommandTool } from "../credential-command.ts";
import contextManagement from "../../context-management/index.ts";

initTheme("dark", false);

let previousKeys = getKeybindings();

beforeEach(() => {
  previousKeys = getKeybindings();
  setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

const cwd = "/tmp/approval-renderer-fixture";
const tools = {
  read: createReadToolDefinition(cwd),
  edit: createEditToolDefinition(cwd),
  write: createWriteToolDefinition(cwd),
  ls: createLsToolDefinition(cwd),
  bash: createBashToolDefinition(cwd),
};
const renderers = createApprovalRenderers(tools);
const ui = { requestRender() {} } as TUI;
const row = (tool: string, args: Record<string, unknown>, rendering = renderers) => {
  const component = new ToolExecutionComponent(
    "approved_action",
    "render-test",
    { tool, arguments: args },
    undefined,
    rendering,
    ui,
    cwd,
  );

  component.setArgsComplete();
  component.markExecutionStarted();

  return component;
};

const display = (component: ToolExecutionComponent) =>
  component
    .render(120)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
const approved = (result: any) => ({
  ...result,
  isError: false,
  content: [
    { type: "text", text: "✓ Auto-Approval · Reviewer\nPasst zur Aufgabe" },
    ...result.content,
  ],
  details: { approval: { decision: "approve" }, result: result.details },
});

const written = (content: string) => ({
  ...approved({ content: [{ type: "text", text: "Wrote file" }], details: { written: true } }),
  details: {
    approval: { decision: "approve", action: { tool: "write", arguments: { content } } },
    result: { written: true },
  },
});

test("read uses its normal title, collapsed output, expansion and truncation details", () => {
  const component = row("read", { path: "example.ts", offset: 10, limit: 5 });

  component.updateResult(
    approved({
      content: [{ type: "text", text: "const visible = 7;" }],
      details: {
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          outputLines: 1,
          totalLines: 10,
          maxLines: 1,
        },
      },
    }),
  );
  expect(display(component)).toContain("read example.ts:10-14");
  expect(display(component)).not.toContain("const visible");
  component.setExpanded(true);
  expect(display(component)).toContain("const visible = 7;");
  expect(display(component)).toContain("Truncated: showing 1 of 10 lines");
  expect(display(component)).toContain("Passt zur Aufgabe");
});

test("edit renders the standard sandbox diff with line numbers and preserves it across redraws", async () => {
  // The result was generated in memory, not read from this nonexistent host path.
  const native = createEditToolDefinition(cwd, {
    operations: {
      access: async () => {},

      readFile: async () => Buffer.from("const before = 1;\n"),
      writeFile: async () => {},
    },
  });
  const args = { path: "sandbox-only.ts", edits: [{ oldText: "before", newText: "after" }] };
  const component = row("edit", args);

  await Bun.sleep(0);
  expect(display(component)).not.toContain("before");
  expect(display(component)).not.toContain("Could not read");

  const result = await native.execute("memory-only", args, undefined, undefined, undefined as any);

  component.updateResult(approved(result));

  const text = display(component);

  expect(text).toContain("edit sandbox-only.ts");
  expect(text).toContain("-1 const before = 1;");
  expect(text).toContain("+1 const after = 1;");
  component.setExpanded(true);
  component.invalidate();
  expect(display(component)).toContain("+1 const after = 1;");

  // Restoring a session also obtains the diff from the persisted tool result.
  const restored = row("edit", args);

  restored.updateResult(approved(result));
  expect(display(restored)).toContain("+1 const after = 1;");
});

test("pending and denied edits never show a successful diff or perform native previews", async () => {
  let complete: boolean | undefined;
  const wrapped = createApprovalRenderers({
    edit: {
      ...tools.edit,
      renderCall(args: any, theme, context: any) {
        complete = context.argsComplete;

        return tools.edit.renderCall!(args, theme, context);
      },
    } as ToolDefinition<any, any>,
  });
  const component = new ToolExecutionComponent(
    "approved_action",
    "denied",
    {
      tool: "edit",
      arguments: {
        path: "never-read-host.txt",
        edits: [{ oldText: "secret-before", newText: "unsafe-after" }],
      },
    },
    undefined,
    wrapped,
    ui,
    cwd,
  );

  component.setArgsComplete();
  await Bun.sleep(0);
  expect(complete).toBe(false);
  component.updateResult(
    {
      content: [{ type: "text", text: "Prüfung läuft" }],
      details: { phase: "reviewing" },
      isError: false,
    },
    true,
  );
  expect(display(component)).toContain("Prüfung läuft");
  component.updateResult({
    content: [{ type: "text", text: "Abgelehnt: nicht gewünscht" }],
    details: { decision: "deny" },
    isError: true,
  });
  expect(display(component)).toContain("Abgelehnt: nicht gewünscht");
  expect(display(component)).not.toContain("secret-before");
  expect(display(component)).not.toContain("unsafe-after");
});

test("write, bash and ls also keep their native presentation", () => {
  const write = row("write", { path: "written.ts", content: "const written = 42;" });

  write.updateResult(written("const written = 42;"));
  expect(display(write)).toContain("write written.ts");
  expect(display(write)).toContain("+1 const written = 42;");

  const ls = row("ls", { path: ".", limit: 100 });

  ls.updateResult(approved({ content: [{ type: "text", text: "example.ts\n" }] }));
  expect(display(ls)).toContain("ls .");
  expect(display(ls)).toContain("example.ts");

  const bash = row("bash", { command: "printf done" });

  bash.updateResult(approved({ content: [{ type: "text", text: "done" }] }));
  expect(display(bash)).toContain("printf done");
  expect(display(bash)).toContain("done");
});

test("writes show only successful sandbox additions, with collapse, expansion and restored results", () => {
  const args = { path: "written.ts", content: "unreviewed-call-content" };
  const component = row("write", args);

  expect(display(component)).not.toContain("unreviewed-call-content");

  const content = Array.from({ length: 24 }, (_, index) => `actual line ${index + 1}`).join("\n");
  const result = written(content);

  component.updateResult(result);
  expect(display(component)).toMatch(/\+\s*1 actual line 1/);
  expect(display(component)).not.toContain("+24 actual line 24");
  expect(display(component)).toContain("to expand");
  component.setExpanded(true);
  component.invalidate();
  expect(display(component)).toContain("+24 actual line 24");
  expect(display(component)).not.toContain("unreviewed-call-content");

  const restored = row("write", args);

  restored.updateResult(JSON.parse(JSON.stringify(result)));
  expect(display(restored)).toMatch(/\+\s*1 actual line 1/);
});

test("denied, pending and failed writes never show written additions", () => {
  for (const result of [
    { content: [{ type: "text", text: "Review pending" }], details: { phase: "reviewing" } },
    {
      content: [{ type: "text", text: "Denied" }],
      details: { approval: { decision: "deny" } },
      isError: true,
    },
    {
      content: [{ type: "text", text: "Write failed" }],
      details: { approval: { decision: "approve" }, executionError: "failure" },
      isError: true,
    },
  ]) {
    const component = row("write", { path: "failure.ts", content: "never written" });

    component.updateResult(result as any);
    expect(display(component)).not.toContain("never written");
    expect(display(component)).not.toContain("+1");

    const success = theme.bg("toolSuccessBg", "sample").split("sample")[0]!;

    expect(component.render(80).join("\n")).not.toContain(success);
  }
});

test("long shell commands collapse only their display and expand back to the complete command", () => {
  const shown: string[] = [];
  const rendering = createApprovalRenderers({
    ...tools,
    bash: {
      ...tools.bash,
      renderCall(args: any, theme: any, context: any) {
        shown.push(args.command);

        return tools.bash.renderCall!(args, theme, context);
      },
    } as ToolDefinition<any, any>,
  });

  for (const command of [
    "cat > /tmp/draft.py <<'PY'\n" + "print('visible-on-expand')\n".repeat(40) + "PY",
    "printf " + "single-line-payload".repeat(60),
  ]) {
    const args = { command, timeout: 10 };
    const component = row("bash", args, rendering);
    const collapsed = display(component)
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");

    expect(collapsed).toContain("ctrl+o to expand");
    expect(collapsed).toContain(`${command.length} characters`);
    expect(collapsed.length).toBeLessThan(400);
    expect(collapsed).toContain("timeout 10s");
    expect(args.command).toBe(command);
    component.setExpanded(true);
    expect(display(component).replace(/\s/g, "")).toContain(command.replace(/\s/g, ""));
    expect(shown.at(-1)).toBe(command);
    component.setExpanded(false);
    expect(display(component)).toContain("ctrl+o to expand");
  }
});

test("one-command network and selected tool bundles are visible", () => {
  const component = new ToolExecutionComponent(
    "approved_action",
    "node-scope",
    {
      tool: "bash",
      arguments: { command: "npm install" },
      network: true,
      sandbox: { tools: ["node"] },
    },
    undefined,
    renderers,
    ui,
    cwd,
  );

  expect(display(component)).toContain("tool: node");
  expect(display(component)).toContain("network: host");
});

test("single-command read-only Git configuration sharing is visible in the activity log", () => {
  const component = new ToolExecutionComponent(
    "approved_action",
    "git-scope",
    {
      tool: "git",
      arguments: { argv: ["commit", "-m", "Reviewed change"] },
      sandbox: { gitConfig: true },
    },
    undefined,
    createApprovalRenderers({ ...tools, git: gitTool }),
    ui,
    cwd,
  );

  expect(display(component)).toContain("git config: read-only · one command");
  expect(display(component)).toContain("Reviewed change");
});

test("credential project read access is visible as a separate one-command request", () => {
  const component = new ToolExecutionComponent(
    "approved_action",
    "credential-files",
    {
      tool: "credential_exec",
      arguments: { profile: "service", argv: ["publish", "body.txt"] },
      sandbox: { projectFiles: "read" },
      network: true,
    },
    undefined,
    renderers,
    ui,
    cwd,
  );

  expect(display(component)).toContain("project files: read · one command");
  expect(display(component)).toContain("network: host");
});

test("web approval stays visible in the activity log while model content is only page text", () => {
  const component = row(
    "webfetch",
    { url: "https://example.com/" },
    createApprovalRenderers({ ...tools, ...webTools }),
  );
  const page = Array.from({ length: 30 }, (_, i) => `Page paragraph ${i}`).join("\n");
  const result = {
    isError: false,
    content: [{ type: "text", text: page }],
    details: {
      approval: { decision: "approve" },
      approvalSummary: "✓ Auto-Approval · allowed",
      result: { hasMore: true, nextOffset: 20000 },
    },
  };

  component.updateResult(result);
  expect(display(component)).toContain("✓ Auto-Approval · allowed");
  expect(display(component)).toContain("Page paragraph 0");
  expect(display(component)).not.toContain("Page paragraph 29");
  component.setExpanded(true);
  expect(display(component)).toContain("Page paragraph 29");
  expect(result.content).toEqual([{ type: "text", text: page }]);
});

test("executor errors remain visible and do not enter native success rendering", () => {
  const component = row("read", { path: "missing.txt" });

  component.updateResult({
    content: [{ type: "text", text: "Approved action failed: missing file" }],
    details: { approval: { decision: "approve" }, executionError: "missing file" },
    isError: true,
  });
  expect(display(component)).toContain("Approved action failed: missing file");
});

test("sandbox requests are visible alongside the native tool without disclosing environment values", () => {
  const component = new ToolExecutionComponent(
    "approved_action",
    "scope",
    {
      tool: "read",
      arguments: { path: "/shared/example.ts" },
      sandbox: {
        paths: [{ path: "/shared", access: "read" }],
        network: "host",
        cip: { node: "cip-2" },
        environment: { MODE: "private-test-value" },
        limits: { executionTimeoutMs: 900000 },
      },
    },
    undefined,
    renderers,
    ui,
    cwd,
  );

  expect(display(component)).toContain("Sandbox request");
  expect(display(component)).toContain("read: /shared");
  expect(display(component)).toContain("network: host");
  expect(display(component)).toContain("environment: MODE");
  expect(display(component)).not.toContain("private-test-value");
  expect(display(component)).toContain("read /shared/example.ts");
  expect(display(component)).toContain("CIP node: cip-2");
});

test("encoded arguments retain the normal command preview", () => {
  const component = new ToolExecutionComponent(
    "approved_action",
    "encoded-render",
    { tool: "bash", arguments: JSON.stringify({ command: "printf encoded-preview" }) },
    undefined,
    renderers,
    ui,
    cwd,
  );

  component.setArgsComplete();
  component.markExecutionStarted();
  expect(display(component)).toContain("printf encoded-preview");
});

test("writes and native edits share the padded success block with approval outside", () => {
  const edit = row("edit", {
    path: "example.ts",
    edits: [{ oldText: "before", newText: "after" }],
  });
  const write = row("write", { path: "example.ts", content: "const after = 1;" });
  const background = theme.bg("toolSuccessBg", "sample").split("sample")[0]!;

  edit.updateResult(
    approved({
      content: [{ type: "text", text: "Edited file" }],
      details: { diff: "+1 const after = 1;" },
    }),
  );
  write.updateResult(written("const after = 1;"));

  for (const component of [edit, write]) {
    const rows = component.render(80);
    const plain = rows.map(stripTerminalSequences);
    const title = plain.findIndex((line) => /(?:edit|write) example.ts/.test(line));
    const addition = plain.findIndex((line) => line.includes("+1 const after = 1;"));
    const approval = plain.findIndex((line) => line.includes("Auto-Approval"));

    expect(rows[title]).toContain(background);
    expect(rows[addition]).toContain(background);
    expect(plain[addition]).toStartWith(" +1");
    expect(visibleWidth(rows[addition]!)).toBe(80);
    expect(addition).toBeGreaterThan(title + 1);
    expect(approval).toBeGreaterThan(addition);
    expect(rows[approval]).not.toContain(background);
    expect(plain.filter((line) => line.includes("+1 const after = 1;"))).toHaveLength(1);
  }
});

test.each([
  ["credential_exec", credentialCommandTool, { profile: "github", argv: ["api", "graphql"] }],
  ["git", gitTool, { argv: ["status"] }],
])(
  "%s fallback output bounds wrapped JSON and expands unchanged persisted content",
  (name, tool, args) => {
    const rendering = createApprovalRenderers({ [name]: tool });
    const output = JSON.stringify({ data: "value ".repeat(800), tail: "LAST-JSON-EVIDENCE" });
    const result = approved({
      content: [{ type: "text", text: output }],
      details: { exitCode: 0 },
    });
    const component = row(name, args, rendering);

    component.updateResult(result);

    for (const width of [30, 80, 120]) {
      const lines = component.render(width).map(stripTerminalSequences);

      expect(lines.length).toBeLessThan(16);
      expect(lines.join("\n")).toContain("ctrl+o");
      expect(lines.join("\n")).not.toContain("LAST-JSON-EVIDENCE");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }

    component.setExpanded(true);
    component.invalidate();
    expect(display(component)).toContain("LAST-JSON-EVIDENCE");
    component.setExpanded(false);
    expect(display(component)).not.toContain("LAST-JSON-EVIDENCE");

    const restored = row(name, args, rendering);

    restored.updateResult(JSON.parse(JSON.stringify(result)));
    expect(display(restored)).not.toContain("LAST-JSON-EVIDENCE");
    restored.setExpanded(true);
    expect(display(restored)).toContain("LAST-JSON-EVIDENCE");
    expect(result.content[1].text).toBe(output);
  },
);

test.each(["notes", "history"])(
  "%s uses an expandable screen-bounded result without changing model data",
  (name) => {
    const definitions = new Map<string, ToolDefinition<any, any>>();

    contextManagement({
      on() {},
      registerCommand() {},
      registerTool(tool: ToolDefinition<any, any>) {
        definitions.set(tool.name, tool);
      },
    } as any);

    const component = new ToolExecutionComponent(
      name,
      "memory-result",
      name === "notes" ? { operation: "set", key: "progress" } : { query: "progress" },
      undefined,
      definitions.get(name),
      ui,
      cwd,
    );
    const output =
      "Working memory (DATA):\n" +
      "Long retained instruction ".repeat(400) +
      "\nLAST-MEMORY-EVIDENCE";
    const result = { content: [{ type: "text" as const, text: output }], isError: false };

    component.updateResult(result);

    for (const width of [30, 80, 120]) {
      const lines = component.render(width).map(stripTerminalSequences);

      expect(lines.length).toBeLessThan(12);
      expect(lines.join("\n")).toContain("ctrl+o");
      expect(lines.join("\n")).not.toContain("LAST-MEMORY-EVIDENCE");
    }

    component.setExpanded(true);
    component.invalidate();
    expect(display(component)).toContain("LAST-MEMORY-EVIDENCE");
    component.setExpanded(false);
    expect(display(component)).not.toContain("LAST-MEMORY-EVIDENCE");
    expect(result.content[0].text).toBe(output);
  },
);

test("fallback failures retain a visible reason and expand all stored diagnostics", () => {
  const component = row("credential_exec", { profile: "github", argv: ["api", "graphql"] });
  const output =
    "Request failed: service unavailable.\n" + "Diagnostic\n".repeat(40) + "LAST-ERROR";

  component.updateResult({
    content: [{ type: "text", text: output }],
    details: { executionError: "service unavailable" },
    isError: true,
  });
  expect(display(component)).toContain("Request failed: service unavailable.");
  expect(display(component)).toContain("ctrl+o");
  expect(display(component)).not.toContain("LAST-ERROR");
  component.setExpanded(true);
  expect(display(component)).toContain("LAST-ERROR");
});

test("collapsed fallback hints follow the configured expansion key", () => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));

  const component = row("git", { argv: ["log"] }, createApprovalRenderers({ git: gitTool }));

  component.updateResult(approved({ content: [{ type: "text", text: "Commit\n".repeat(30) }] }));
  expect(display(component)).toContain("ctrl+e to expand");
  expect(display(component)).not.toContain("ctrl+o");
});

test("empty command output adds neither a body spacer nor an expansion hint", () => {
  const component = row(
    "git",
    { argv: ["add", "sample.txt"] },
    createApprovalRenderers({ git: gitTool }),
  );

  component.updateResult(approved({ content: [{ type: "text", text: "" }] }));
  expect(component.render(120)).toHaveLength(4); // Transcript spacer, call and two approval lines.
  expect(display(component)).not.toContain("to expand");
});
