import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function reviewSummary(
  approved: boolean,
  reason: string,
  durationMs: number,
  reviewer: string,
) {
  // Language-neutral header; the reviewer writes the reason in the user's language.
  return `${approved ? "✓" : "✗"} Auto-Approval · ${(durationMs / 1000).toFixed(1)} s · ${reviewer}\n${reason}`;
}

export function startReviewDisplay(ctx: ExtensionContext, reviewer: string) {
  const started = performance.now();
  let frame = 0;
  const tick = () => {
    const text = `${frames[frame++ % frames.length]} approval: ${reviewer.replace(/ \([^)]*\)$/, "")}`;

    ctx.ui.setStatus("auto-approval", text);
  };

  tick();

  // Timers belong to this one review, never to the extension factory.
  const timer = setInterval(tick, 100);

  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
      ctx.ui.setStatus("auto-approval", undefined);

      return Math.max(0, performance.now() - started);
    },
  };
}
