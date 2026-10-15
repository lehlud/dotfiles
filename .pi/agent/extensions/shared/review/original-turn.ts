import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  OriginalLookupError,
  parsePromptLookup,
  promptOriginalTool,
  readPromptOriginal,
  type PromptLookup,
} from "./originals.ts";

export class ReviewerToolError extends Error {}

export type PromptLookupFailure = { code: OriginalLookupError["code"]; attempt: number };

export type LookupObserver = {
  lookup?(request: PromptLookup): void;
  lookupFailed?(failure: PromptLookupFailure): void;
};

export type LookupProgress = {
  attempts: number;
  failures: number;
  limit: number;
  promptLookups: PromptLookup[];
  consulted: Set<string>;
};

function auditLookup(record: () => void): void {
  try {
    record();
  } catch {
    throw new ReviewerToolError("Reviewer original-prompt lookup audit failed");
  }

}

/** This turn can only read selected in-memory originals; errors authorize no action. */
export function originalLookupTurn(
  call: ToolCall,
  sources: ReadonlyMap<string, string>,
  progress: LookupProgress,
  observer: LookupObserver,
): ToolResultMessage {
  if (call.name !== promptOriginalTool.name) {
    throw new ReviewerToolError("Reviewer requested an unsupported tool");
  }

  if (progress.attempts >= progress.limit) {
    throw new ReviewerToolError("Reviewer original-prompt lookup limit exceeded");
  }

  progress.attempts++;

  let request: PromptLookup;
  let result: ReturnType<typeof readPromptOriginal>;

  try {
    request = parsePromptLookup(call.arguments);
    result = readPromptOriginal(sources, request);
  } catch (error) {
    if (!(error instanceof OriginalLookupError)) {
      throw new ReviewerToolError("Reviewer original-prompt reader failed");
    }

    progress.failures++;
    auditLookup(() => observer.lookupFailed?.({ code: error.code, attempt: progress.attempts }));

    if (progress.failures >= 3) {
      throw new ReviewerToolError(
        `Reviewer original-prompt lookup failed after three invalid reads (${error.code})`,
      );
    }

    return toolResult(
      call,
      {
        error: { code: error.code, message: error.message },
        availablePromptIds: [...sources.keys()],
        instruction:
          "Correct this lookup using prompt_original. No action has executed. Originals remain authoritative; final approval still requires inspection of every compressed original.",
      },
      true,
    );
  }

  progress.promptLookups.push(structuredClone(request));
  auditLookup(() => observer.lookup?.(structuredClone(request)));

  if (result.excerpts.some((excerpt) => excerpt.text.length)) {
    progress.consulted.add(result.promptId);
  }

  return toolResult(call, result, false);
}

function toolResult(call: ToolCall, result: unknown, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError,
    timestamp: Date.now(),
  };
}

