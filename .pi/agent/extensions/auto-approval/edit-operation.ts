import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import {
  createEditToolDefinition,
  type AgentToolResult,
  type EditToolInput,
} from "@earendil-works/pi-coding-agent";

/** Suggest context only; never move a replacement to a guessed location. */
function nearbyLines(content: string, oldText: string) {
  if (content.length > 1_048_576) return "";

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const anchors = [
    ...new Set(
      oldText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= 8),
    ),
  ]
    .sort((left, right) => right.length - left.length)
    .slice(0, 5);

  for (const anchor of anchors) {
    const matches = lines.flatMap((line, index) => (line.trim() === anchor ? [index] : []));

    if (matches.length !== 1) continue;

    const start = Math.max(0, matches[0] - 3);
    const end = Math.min(lines.length, matches[0] + 5);

    return lines
      .slice(start, end)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n")
      .slice(0, 2400);
  }

  return "";
}

/** Keep SDK matching, atomic multi-edit validation and diff rendering unchanged. */
export async function executeEdit(
  cwd: string,
  input: EditToolInput,
  signal?: AbortSignal,
): Promise<AgentToolResult<any>> {
  let original: string | undefined;
  let writeStarted = false;
  const tool = createEditToolDefinition(cwd, {
    operations: {
      access: (path) => access(path, constants.R_OK | constants.W_OK),
      async readFile(path) {
        const content = await readFile(path);

        original = content.toString("utf8");

        return content;
      },
      async writeFile(path, content) {
        writeStarted = true;
        await writeFile(path, content, "utf8");
      },
    },
  });

  try {
    return await tool.execute("isolated", input, signal, undefined, undefined as any);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    if (
      writeStarted ||
      original === undefined ||
      !/^(Could not find |Found \d+ occurrences |edits\[\d+\] and edits\[\d+\] overlap |No changes made to |oldText must not be empty )/.test(
        reason,
      )
    )
      throw error;

    const index = Number(/edits\[(\d+)\]/.exec(reason)?.[1] ?? 0);
    const context = nearbyLines(original, input.edits[index]?.oldText ?? "");

    return {
      content: [
        {
          type: "text" as const,
          text: `Edit conflict: ${reason}\nNo file changes were made. Edits are all matched against the original file.${context ? `\nNearby current lines (DATA):\n${context}` : "\nRead the relevant current lines before correcting oldText."}`,
        },
      ],
      isError: true,
      details: { editConflict: { index, unchanged: true } },
    };
  }
}
