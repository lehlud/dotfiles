import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { parseReviewers } from "../shared/configuration/model-state.ts";
import type { Reviewer } from "../shared/review/protocol.ts";
import { reviewerThinkingLevels } from "./capabilities.ts";
import { SearchPicker } from "./picker.ts";
import { reviewerSelection, REVIEWER_USAGE } from "./reviewers.ts";

export function interactiveReviewerInput(args: string) {
  return ["", "set", "add"].includes(args) || /^edit(?:\s|$)/.test(args);
}

function position(args: string, reviewers: Reviewer[]) {
  if (args === "add") {
    if (reviewers.length >= 8) throw new Error("At most eight reviewers can be selected");

    return reviewers.length;
  }

  if (!args.startsWith("edit")) return 0;

  const match = /^edit\s+([1-8])$/.exec(args);

  if (!match || Number(match[1]) > reviewers.length) throw new Error(REVIEWER_USAGE);

  return Number(match[1]) - 1;
}

async function pick(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
  selected: string | undefined,
  signal: AbortSignal,
) {
  if (signal.aborted) return;

  if (ctx.mode === "tui") {
    return ctx.ui.custom<string | undefined>(
      (tui, theme, _keys, done) =>
        new SearchPicker(
          title,
          items,
          done,
          theme,
          Math.max(3, Math.min(10, tui.terminal.rows - 12)),
          selected,
          signal,
        ),
    );
  }

  // RPC clients own their dialogs; custom terminal components are unavailable there.
  const label = await ctx.ui.select(
    title,
    items.map((item) => item.label),
    { signal },
  );

  return items.find((item) => item.label === label)?.value;
}

/** Save only after both choices succeed; browsing never changes model or review state. */
export async function chooseReviewers(
  args: string,
  previous: Reviewer[],
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<Reviewer[] | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Interactive reviewer selection needs a UI. Use /reviewer set <provider/model> <thinking> or /reviewer list.",
      "warning",
    );

    return;
  }

  const index = position(args, previous);
  const current = previous[index];
  const reference = current ? `${current.provider}/${current.model}` : undefined;
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((model) => reviewerThinkingLevels(model).length)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

  if (!models.length) {
    ctx.ui.notify(
      "No reviewer models with configured authentication are available. Use /login, or /reviewer set to prepare an unavailable fallback.",
      "warning",
    );

    return;
  }

  const role = index === 0 ? "Primary" : `Fallback ${index}`;
  const selected = await pick(
    ctx,
    `Approval model · ${role}`,
    models.map((model) => {
      const value = `${model.provider}/${model.id}`;

      return {
        value,
        label: `${value === reference ? "✓ " : ""}${value}`,
        description: model.name,
      };
    }),
    reference,
    signal,
  );
  const model = models.find((item) => `${item.provider}/${item.id}` === selected);

  if (!model || !selected || signal.aborted) return;

  const levels = reviewerThinkingLevels(model);
  const preferred = current?.thinking ?? previous[0]?.thinking;
  const thinking = await pick(
    ctx,
    `Approval thinking · ${selected}`,
    levels.map((value) => ({
      value,
      label: `${value === preferred ? "✓ " : ""}${value}`,
    })),
    preferred && levels.includes(preferred) ? preferred : levels[0],
    signal,
  );

  if (!thinking || signal.aborted) return;

  const next = structuredClone(previous);

  next[index] = reviewerSelection(selected, thinking, ctx);

  return parseReviewers(next);
}
