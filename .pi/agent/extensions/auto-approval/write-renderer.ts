import { keyHint, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Show only the written contents; no host preview or before-file lookup is needed. */
export function renderWrittenDiff(diff: string, expanded: boolean, theme: Theme): Text {
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
