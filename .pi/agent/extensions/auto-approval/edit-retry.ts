import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ActionAudit, Entry } from "../shared/review/entries.ts";

export const editRetrySchema = Type.Object(
  {
    retry: Type.String({
      minLength: 1,
      maxLength: 100,
      description: "Request ID of a prior approved edit in this session branch.",
    }),
    edits: Type.Array(
      Type.Object(
        { index: Type.Integer({ minimum: 0 }), oldText: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

/** Reuse text, never approval or permissions. The expanded action takes the normal gate. */
export function expandEditRetry(value: unknown, entries: readonly Entry[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const request = value as Record<string, unknown>;

  if (
    request.tool !== "edit" ||
    !request.arguments ||
    typeof request.arguments !== "object" ||
    Array.isArray(request.arguments) ||
    !("retry" in request.arguments)
  )
    return value;

  if (!Check(editRetrySchema, request.arguments))
    throw new Error("Invalid edit retry; supply retry and edits [{index,oldText}]");

  const correction = request.arguments as Static<typeof editRetrySchema>;
  const audit = entries.findLast(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "auto-approval-review" &&
      (entry.data as ActionAudit | undefined)?.requestId === correction.retry,
  )?.data as ActionAudit | undefined;

  if (
    audit?.decision !== "approve" ||
    audit.action?.tool !== "edit" ||
    !Array.isArray(audit.action.arguments?.edits)
  )
    throw new Error(
      "Unknown approved edit retry in this session branch; submit a full edit instead",
    );

  const editArguments = structuredClone(audit.action.arguments);
  const edits = editArguments.edits as { oldText: string; newText: string }[];
  const changed = new Set<number>();

  for (const { index, oldText } of correction.edits) {
    if (!Number.isSafeInteger(index) || !edits[index] || changed.has(index))
      throw new Error("Edit retry indices must exist and be unique");

    changed.add(index);
    edits[index].oldText = oldText;
  }

  return { ...request, arguments: editArguments };
}
