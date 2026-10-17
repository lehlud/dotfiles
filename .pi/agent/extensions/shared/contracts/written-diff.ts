import { generateDiffString } from "@earendil-works/pi-coding-agent";

/** Use the immutable approved content only after the executor confirms the write. */
export function writtenDiff(approval: unknown, outcome: unknown): string | undefined {
  const receipt = approval as
    | {
        decision?: unknown;
        action?: { tool?: unknown; arguments?: { content?: unknown } };
      }
    | null
    | undefined;
  const result = outcome as { written?: unknown } | null | undefined;
  const content = receipt?.action?.arguments?.content;

  if (
    receipt?.decision !== "approve" ||
    receipt?.action?.tool !== "write" ||
    result?.written !== true ||
    typeof content !== "string"
  ) {
    return undefined;
  }

  return generateDiffString("", content).diff;
}
