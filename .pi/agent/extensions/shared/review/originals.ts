import { Type } from "typebox";
import { Check } from "typebox/value";
import type { Tool } from "@earendil-works/pi-ai";

export const promptOriginalTool: Tool = {
  name: "prompt_original",
  description:
    "Read the original of a selected compressed operator prompt by its promptId. No filesystem, shell or network access. head/tail/read return character ranges; grep searches a literal case-sensitive string and returns bounded excerpts with offsets. Use read to continue an excerpt. Originals override summaries.",
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

export function readPromptOriginal(sources: ReadonlyMap<string, string>, args: unknown) {
  if (!Check(promptOriginalTool.parameters, args))
    throw new Error("Invalid original-prompt lookup; no other tools or paths are allowed");

  const request = args as {
    promptId: string;
    operation: string;
    offset?: number;
    limit?: number;
    query?: string;
  };
  const text = sources.get(request.promptId);

  if (text === undefined)
    throw new Error("Original prompt is not in this review's selected branch context");

  const limit = request.limit ?? 4000;
  const excerpts: { offset: number; text: string }[] = [];
  let more = false;

  if (request.operation === "grep") {
    if (!request.query) throw new Error("Literal grep query is required");

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

    if (start > text.length) throw new Error("Original prompt offset is outside the text");

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

