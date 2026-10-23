import { actionSnapshot } from "../shared/contracts/action-snapshot.ts";
import { Box, Container, Text, type Component } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderFileDiff } from "../shared/presentation/file-diff.ts";
import { writtenDiff } from "../shared/contracts/written-diff.ts";
import { renderTextResult } from "../shared/presentation/text-result.ts";

type NativeTool = ToolDefinition<any, any>;

type ToolRenderContext = Parameters<NonNullable<NativeTool["renderCall"]>>[2];

type RenderState = {
  tool: string;
  native: Record<string, unknown>;
  call?: Component;
  result?: Component;
  wrapper: Container;
  callWrapper?: Container;
  writeCall?: Box;
  writeDiff?: string;
};

/** Display the built-in tool, without giving its renderer unreviewed host IO. */
export function createApprovalRenderers(
  tools: Record<string, NativeTool>,
): Pick<NativeTool, "renderShell" | "renderCall" | "renderResult"> {
  function slot(context: ToolRenderContext, tool: string): RenderState {
    const old = context.state.approvedActionRendering as RenderState | undefined;

    if (old?.tool === tool) return old;

    return (context.state.approvedActionRendering = { tool, native: {}, wrapper: new Container() });
  }

  const definition = (name: string) => (Object.hasOwn(tools, name) ? tools[name] : undefined);
  const nativeContext = (
    context: ToolRenderContext,
    state: RenderState,
    lastComponent?: Component,
  ): ToolRenderContext => ({
    ...context,
    args: (context.args as any)?.arguments ?? {},
    state: state.native,
    lastComponent,
    // Pi's edit call renderer otherwise computes its preview by reading the
    // host before approval. Its result renderer populates the same standard
    // diff from the actual, sandbox-produced result after execution instead.
    argsComplete: state.tool === "edit" ? false : context.argsComplete,
  });

  return {
    renderShell: "self",
    renderCall(args: any, theme, context) {
      const name = typeof args?.tool === "string" ? args.tool : "";
      const state = slot(context, name);
      const tool = definition(name);
      let displayed = args?.arguments ?? {};

      try {
        displayed = (actionSnapshot(args) as any)?.arguments ?? {};
      } catch {
        displayed = {};
      }

      const command = displayed.command;

      if (name === "write") {
        displayed = { ...displayed, content: "" };
      }

      if (
        ["bash", "powershell"].includes(name) &&
        typeof command === "string" &&
        !context.expanded &&
        (command.length > 300 || command.split("\n").length > 5)
      ) {
        const lines = command.split("\n");
        const preview = lines[0].slice(0, 160);

        displayed = {
          ...displayed,
          command: `${preview} …\n[${lines.length} lines, ${command.length} characters · ctrl+o to expand]`,
        };
      }

      state.call =
        tool?.renderCall?.(displayed, theme, {
          ...nativeContext(context, state, state.call),
          args: displayed,
        }) ?? new Text(theme.fg("toolTitle", theme.bold(name || "approved_action")), 0, 0);

      let call = state.call;

      if (name === "write") {
        state.writeCall = renderFileDiff(
          state.call,
          state.writeDiff,
          context,
          theme,
          state.writeCall,
        );
        call = state.writeCall;
      }

      if (args?.sandbox || args?.network !== undefined) {
        const changes = {
          ...args.sandbox,
          ...(args?.network !== undefined ? { network: args.network ? "host" : "none" } : {}),
        };
        const labels = [
          ...(changes.maintenance ? ["Pi maintenance · one action"] : []),
          ...(changes.projectFiles ? [`project files: ${changes.projectFiles} · one command`] : []),
          ...(changes.gitConfig === true ? ["git config: read-only · one command"] : []),
          ...(changes.tools ?? []).map((name: string) => `tool: ${name}`),
          ...(changes.paths ?? []).map(
            (entry: any) =>
              `${entry.access}: ${entry.path}${entry.create ? ` (create ${entry.create})` : ""}`,
          ),
          ...(changes.network ? [`network: ${changes.network}`] : []),
          ...(changes.environment
            ? [`environment: ${Object.keys(changes.environment).join(", ")}`]
            : []),
          ...(changes.executableSearchPaths ?? []).map((path: string) => `PATH: ${path}`),
          ...Object.entries(changes.limits ?? {}).map(([key, value]) => `${key}: ${value}`),
        ];

        state.callWrapper ??= new Container();
        state.callWrapper.clear();
        state.callWrapper.addChild(
          new Text(theme.fg("warning", `Sandbox request · ${labels.join(" · ")}`), 0, 0),
        );
        state.callWrapper.addChild(call);

        return state.callWrapper;
      }

      return call;
    },

    renderResult(result, options, theme, context) {
      const args = context.args as any;
      const name = typeof args?.tool === "string" ? args.tool : "";
      const state = slot(context, name);

      state.wrapper.clear();

      const details = result.details;
      // The wrapper adds exactly one decision block before the original
      // result. Keep it out of syntax highlighting and tool-specific output.
      const completed = !options.isPartial && details?.approval && Object.hasOwn(details, "result");

      if (name === "write" && state.call) {
        state.writeDiff =
          completed && !context.isError ? writtenDiff(details.approval, details.result) : undefined;
        state.writeCall = renderFileDiff(
          state.call,
          state.writeDiff,
          context,
          theme,
          state.writeCall,
        );
      }

      if (completed) {
        const decision = details.approvalSummary
          ? { type: "text", text: details.approvalSummary }
          : result.content[0];

        if (decision?.type === "text")
          state.wrapper.addChild(new Text(theme.fg("muted", decision.text), 0, 0));

        if (state.writeDiff !== undefined) {
          return state.wrapper;
        }

        const output = {
          ...result,
          content: details.approvalSummary ? result.content : result.content.slice(1),
          details: details.result,
        };
        const tool = definition(name);

        state.result =
          tool?.renderResult?.(
            output,
            options,
            theme,
            nativeContext(context, state, state.result),
          ) ?? renderTextResult(output, options, theme, nativeContext(context, state));
        state.wrapper.addChild(state.result);
      } else {
        // Reviews, denials and technical failures have no underlying result.
        // In particular, never present a denied edit as a successful diff.
        state.wrapper.addChild(renderTextResult(result, options, theme, context));
      }

      return state.wrapper;
    },
  };
}
