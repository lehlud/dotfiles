import { Type } from "typebox";
import { Check } from "typebox/value";
import type { Tool } from "@earendil-works/pi-ai";

export type PromptLookup = {
  promptId: string;
  operation: "head" | "tail" | "read" | "grep";
  offset?: number;
  limit?: number;
  query?: string;
};

export class OriginalLookupError extends Error {
  constructor(
    public readonly code: "invalid-arguments" | "unknown-prompt" | "invalid-range",
    message: string,
  ) {
    super(message);
  }
}

export const promptOriginalTool: Tool = {
  name: "prompt_original",
  description:
    "Read the original of a selected compressed operator prompt by its promptId from userPromptInfo where compressed is true. No filesystem, shell or network access. head/tail/read return character ranges, not lines; limit is at most 8000 characters. grep searches a literal case-sensitive string and returns bounded excerpts with offsets. Use read to continue an excerpt. Originals override summaries. A tool error describes how to correct the lookup within this same review.",
  parameters: Type.Object(
    {
      promptId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      operation: Type.Union([
        Type.Literal("head"),
        Type.Literal("tail"),
        Type.Literal("read"),
        Type.Literal("grep"),
      ]),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    },
    { additionalProperties: false },
  ),
};

/** Accept equivalent wire encodings without inventing fields, ranges or prompt identities. */
export function parsePromptLookup(args: unknown): PromptLookup {
  let value = args;

  if (typeof value === "string" && Buffer.byteLength(value) <= 8192) {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }

  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = { ...value };

    for (const key of ["offset", "limit", "query"]) {
      if ((value as Record<string, unknown>)[key] === null) {
        delete (value as Record<string, unknown>)[key];
      }

    }

  }

  if (!Check(promptOriginalTool.parameters, value)) {
    throw new OriginalLookupError(
      "invalid-arguments",
      "Invalid original-prompt lookup. Use only promptId, operation (head/tail/read/grep), optional nonnegative offset, limit 1–8000 characters, and a literal grep query. No other tools or paths are allowed.",
    );
  }

  return value as PromptLookup;
}

export function readPromptOriginal(sources: ReadonlyMap<string, string>, args: unknown) {
  const request = parsePromptLookup(args);
  const text = sources.get(request.promptId);

  if (text === undefined)
    throw new OriginalLookupError(
      "unknown-prompt",
      "Original prompt is not in this review's selected branch context. Use an available promptId from userPromptInfo marked compressed.",
    );

  const limit = request.limit ?? 4000;
  const excerpts: { offset: number; text: string }[] = [];
  let more = false;

  if (request.operation === "grep") {
    if (!request.query) {
      throw new OriginalLookupError("invalid-arguments", "Literal grep query is required");
    }

    if ((request.offset ?? 0) > text.length) {
      throw new OriginalLookupError("invalid-range", "Original prompt offset is outside the text");
    }

    let offset = request.offset ?? 0,
      remaining = limit;

    while (excerpts.length < 8 && remaining > 0) {
      const match = text.indexOf(request.query, offset);

      if (match < 0) break;

      const start = Math.max(offset, match - 160);
      const end = Math.min(text.length, start + Math.min(remaining, 1000));

      excerpts.push({ offset: start, text: text.slice(start, end) });
      remaining -= end - start;
      offset = Math.max(end, match + request.query.length);
    }

    more =
      text.indexOf(
        request.query,
        excerpts.at(-1) ? excerpts.at(-1)!.offset + excerpts.at(-1)!.text.length : offset,
      ) >= 0;
  } else {
    const start =
      request.operation === "head"
        ? 0
        : request.operation === "tail"
          ? Math.max(0, text.length - limit)
          : (request.offset ?? 0);

    if (start > text.length)
      throw new OriginalLookupError("invalid-range", "Original prompt offset is outside the text");

    excerpts.push({ offset: start, text: text.slice(start, start + limit) });
    more = start + limit < text.length;
  }

  return {
    promptId: request.promptId,
    operation: request.operation,
    originalChars: text.length,
    excerpts,
    hasMore: more,
    nextOffset: excerpts.at(-1)
      ? excerpts.at(-1)!.offset + excerpts.at(-1)!.text.length
      : (request.offset ?? 0),
  };
}
