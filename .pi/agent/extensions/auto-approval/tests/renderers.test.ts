import { test, expect } from "bun:test";
import {
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createLsToolDefinition, createBashToolDefinition, initTheme, ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createApprovalRenderers } from "../renderers.ts";

initTheme("dark", false);
const cwd = "/tmp/approval-renderer-fixture";
const tools = {
  read: createReadToolDefinition(cwd), edit: createEditToolDefinition(cwd),
  write: createWriteToolDefinition(cwd), ls: createLsToolDefinition(cwd), bash: createBashToolDefinition(cwd),
};
const renderers = createApprovalRenderers(tools);
const ui = { requestRender() {} } as TUI;
const row = (tool: string, args: Record<string, unknown>) => {
  const component = new ToolExecutionComponent("approved_action", "render-test", { tool, arguments: args }, undefined, renderers, ui, cwd);
  component.setArgsComplete(); component.markExecutionStarted();
  return component;
};
const display = (component: ToolExecutionComponent) => component.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const approved = (result: any) => ({
  ...result, isError: false,
  content: [{ type: "text", text: "✓ Auto-Approval · Reviewer\nPasst zur Aufgabe" }, ...result.content],
  details: { approval: { decision: "approve" }, result: result.details },
});

test("read uses its normal title, collapsed output, expansion and truncation details", () => {
  const component = row("read", { path: "example.ts", offset: 10, limit: 5 });
  component.updateResult(approved({ content: [{ type: "text", text: "const visible = 7;" }], details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 10, maxLines: 1 } } }));
  expect(display(component)).toContain("read example.ts:10-14");
  expect(display(component)).not.toContain("const visible");
  component.setExpanded(true);
  expect(display(component)).toContain("const visible = 7;");
  expect(display(component)).toContain("Truncated: showing 1 of 10 lines");
  expect(display(component)).toContain("Passt zur Aufgabe");
});

test("edit renders the standard sandbox diff with line numbers and preserves it across redraws", async () => {
  // The result was generated in memory, not read from this nonexistent host path.
  const native = createEditToolDefinition(cwd, { operations: {
    access: async () => {}, readFile: async () => Buffer.from("const before = 1;\n"), writeFile: async () => {},
  } });
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
  component.setExpanded(true); component.invalidate();
  expect(display(component)).toContain("+1 const after = 1;");
  // Restoring a session also obtains the diff from the persisted tool result.
  const restored = row("edit", args); restored.updateResult(approved(result));
  expect(display(restored)).toContain("+1 const after = 1;");
});

test("pending and denied edits never show a successful diff or perform native previews", async () => {
  let complete: boolean | undefined;
  const wrapped = createApprovalRenderers({ edit: { ...tools.edit, renderCall(args: any, theme, context: any) {
    complete = context.argsComplete;
    return tools.edit.renderCall!(args, theme, context);
  } } as ToolDefinition<any, any> });
  const component = new ToolExecutionComponent("approved_action", "denied", {
    tool: "edit", arguments: { path: "never-read-host.txt", edits: [{ oldText: "secret-before", newText: "unsafe-after" }] },
  }, undefined, wrapped, ui, cwd);
  component.setArgsComplete(); await Bun.sleep(0);
  expect(complete).toBe(false);
  component.updateResult({ content: [{ type: "text", text: "Prüfung läuft" }], details: { phase: "reviewing" }, isError: false }, true);
  expect(display(component)).toContain("Prüfung läuft");
  component.updateResult({ content: [{ type: "text", text: "Abgelehnt: nicht gewünscht" }], details: { decision: "deny" }, isError: true });
  expect(display(component)).toContain("Abgelehnt: nicht gewünscht");
  expect(display(component)).not.toContain("secret-before");
  expect(display(component)).not.toContain("unsafe-after");
});

test("write, bash and ls also keep their native presentation", () => {
  const write = row("write", { path: "written.ts", content: "const written = 42;" });
  write.updateResult(approved({ content: [{ type: "text", text: "Successfully wrote file" }] }));
  expect(display(write)).toContain("write written.ts");
  expect(display(write)).toContain("const written = 42;");
  const ls = row("ls", { path: ".", limit: 100 });
  ls.updateResult(approved({ content: [{ type: "text", text: "example.ts\n" }] }));
  expect(display(ls)).toContain("ls ."); expect(display(ls)).toContain("example.ts");
  const bash = row("bash", { command: "printf done" });
  bash.updateResult(approved({ content: [{ type: "text", text: "done" }] }));
  expect(display(bash)).toContain("printf done"); expect(display(bash)).toContain("done");
});

test("executor errors remain visible and do not enter native success rendering", () => {
  const component = row("read", { path: "missing.txt" });
  component.updateResult({ content: [{ type: "text", text: "Approved action failed: missing file" }], details: { approval: { decision: "approve" }, executionError: "missing file" }, isError: true });
  expect(display(component)).toContain("Approved action failed: missing file");
});
test("sandbox requests are visible alongside the native tool without disclosing environment values", () => {
  const component = new ToolExecutionComponent("approved_action", "scope", {
    tool: "read", arguments: { path: "/shared/example.ts" }, sandbox: { paths: [{ path: "/shared", access: "read" }], network: "host", environment: { MODE: "private-test-value" }, limits: { executionTimeoutMs: 900000 } },
  }, undefined, renderers, ui, cwd);
  expect(display(component)).toContain("Sandbox request");
  expect(display(component)).toContain("read: /shared"); expect(display(component)).toContain("network: host");
  expect(display(component)).toContain("environment: MODE"); expect(display(component)).not.toContain("private-test-value");
  expect(display(component)).toContain("read /shared/example.ts");
});
