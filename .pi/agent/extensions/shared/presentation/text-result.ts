import { keyHint, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

const PREVIEW_LINES = 3;

/** Bound screen rows, including wrapped JSON; expansion reads the unchanged result. */
export const renderTextResult: NonNullable<ToolDefinition<any, any>["renderResult"]> = (
  result,
  options,
  theme,
  context,
) => {
  const output = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const clean = stripTerminalSequences(output);
  const text = new Text(
    clean.trim() ? theme.fg(context.isError ? "error" : "toolOutput", clean) : "",
    0,
    0,
  );

  return {
    render(width) {
      const lines = text.render(width);

      if (options.expanded || lines.length <= PREVIEW_LINES) return lines;

      const hint = theme.fg(
        "muted",
        `[${keyHint("app.tools.expand", "to expand")} · ${lines.length - PREVIEW_LINES} more lines]`,
      );

      return [...lines.slice(0, PREVIEW_LINES), truncateToWidth(hint, width)];
    },
    invalidate() {
      text.invalidate();
    },
  };
};
