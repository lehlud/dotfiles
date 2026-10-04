import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type NativeTool = ToolDefinition<any, any>;
type ToolRenderContext = Parameters<NonNullable<NativeTool["renderCall"]>>[2];
type RenderState = {
  tool: string;
  native: Record<string, unknown>;
  call?: Component;
  result?: Component;
  wrapper: Container;
  callWrapper?: Container;
};

/** Display the built-in tool, without giving its renderer unreviewed host IO. */
export function createApprovalRenderers(tools: Record<string, NativeTool>): Pick<NativeTool, "renderShell" | "renderCall" | "renderResult"> {
  function slot(context: ToolRenderContext, tool: string): RenderState {
    const old = context.state.approvedActionRendering as RenderState | undefined;
    if (old?.tool === tool) return old;
    return context.state.approvedActionRendering = { tool, native: {}, wrapper: new Container() };
  }
  const definition = (name: string) => Object.hasOwn(tools, name) ? tools[name] : undefined;
  const nativeContext = (context: ToolRenderContext, state: RenderState, lastComponent?: Component): ToolRenderContext => ({
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
      state.call = tool?.renderCall?.(args?.arguments ?? {}, theme, nativeContext(context, state, state.call))
        ?? new Text(theme.fg("toolTitle", theme.bold(name || "approved_action")), 0, 0);
      if (args?.sandbox) {
        const changes = args.sandbox;
        const labels = [
          ...(changes.paths ?? []).map((entry: any) => `${entry.access}: ${entry.path}`),
          ...(changes.network ? [`network: ${changes.network}`] : []),
          ...(changes.environment ? [`environment: ${Object.keys(changes.environment).join(", ")}`] : []),
          ...(changes.executableSearchPaths ?? []).map((path: string) => `PATH: ${path}`),
          ...Object.entries(changes.limits ?? {}).map(([key, value]) => `${key}: ${value}`),
        ];
        state.callWrapper ??= new Container();
        state.callWrapper.clear();
        state.callWrapper.addChild(new Text(theme.fg("warning", `Sandbox request · ${labels.join(" · ")}`), 0, 0));
        state.callWrapper.addChild(state.call);
        return state.callWrapper;
      }
      return state.call;
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
      if (completed) {
        const decision = result.content[0];
        if (decision?.type === "text") state.wrapper.addChild(new Text(theme.fg("muted", decision.text), 0, 0));
        const output = { ...result, content: result.content.slice(1), details: details.result };
        const tool = definition(name);
        state.result = tool?.renderResult?.(output, options, theme, nativeContext(context, state, state.result))
          ?? new Text(output.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
        state.wrapper.addChild(state.result);
      } else {
        // Reviews, denials and technical failures have no underlying result.
        // In particular, never present a denied edit as a successful diff.
        const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        state.wrapper.addChild(new Text(theme.fg(context.isError ? "error" : "muted", text), 0, 0));
      }
      return state.wrapper;
    },
  };
}
