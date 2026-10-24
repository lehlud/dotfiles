import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadSessionConfig } from "../shared/session/config.ts";
import { compressionJournal, preparePromptContext } from "../shared/review/compression.ts";
import { sessionServices } from "../shared/session/services.ts";
import type { Goal } from "../shared/contracts/goal.ts";

/** Goal proposals and completion checks use the same original operator evidence. */
export async function prepareGoalEvidence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: Pick<Goal, "text" | "source"> & { id?: string },
  signal: AbortSignal,
  display: (status: string) => void,
) {
  const config = await loadSessionConfig(ctx);
  const processing = { fastMode: () => sessionServices(ctx).fastMode?.() ?? false };
  const branch = ctx.sessionManager.getBranch();
  const prepared = await preparePromptContext(
    branch,
    config,
    ctx.modelRegistry,
    getAgentDir(),
    compressionJournal(pi, branch, { goalId: target.id }, () => display("compressing")),
    signal,
    target.source === "agent" ? undefined : target.text,
    processing,
  );

  return { config, processing, branch, prepared };
}
