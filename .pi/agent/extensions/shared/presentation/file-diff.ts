import { keyHint, renderDiff, type Theme, type ThemeBg } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, type Component } from "@earendil-works/pi-tui";

function diffBody(diff: string, expanded: boolean, theme: Theme): Text {
  if (!diff) {
    return new Text(theme.fg("muted", "Empty file"), 0, 0);
  }

  const lines = diff.split("\n");
  const visible = expanded ? lines : lines.slice(0, 10);
  const remaining = lines.length - visible.length;
  const more =
    remaining > 0
      ? `\n${theme.fg("muted", `[${remaining} more lines · ${keyHint("app.tools.expand", "to expand")}]`)}`
      : "";

  return new Text(renderDiff(visible.join("\n")) + more, 0, 0);
}

/** Match the native edit shell; only confirmed contents receive success styling. */
export function renderFileDiff(
  header: Component,
  diff: string | undefined,
  options: { expanded: boolean; isError?: boolean },
  theme: Theme,
  previous?: Box,
): Box {
  const box = previous ?? new Box(1, 1);
  let background: ThemeBg = "toolPendingBg";

  if (options.isError) {
    background = "toolErrorBg";
  } else if (diff !== undefined) {
    background = "toolSuccessBg";
  }

  box.setBgFn((text) => theme.bg(background, text));
  box.clear();
  box.addChild(header);

  if (diff !== undefined) {
    box.addChild(new Spacer(1));
    box.addChild(diffBody(diff, options.expanded, theme));
  }

  return box;
}
