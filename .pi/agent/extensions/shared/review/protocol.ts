import { requestDeadline } from "../providers/request-deadline.ts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const reviewerSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 200 }),
    model: Type.String({ minLength: 1, maxLength: 200 }),
    thinking: Type.Union([
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ]),
  },
  { additionalProperties: false },
);

export type Reviewer = Static<typeof reviewerSchema>;

export type ReviewSettings = {
  reviewer?: Reviewer;
  recentUserPrompts: number;
  requestTimeoutMs: number;
};

export const REVIEW_LANGUAGE = `Write the reason in the language of latestUserPrompt, the LAST actual operator prompt. Determine the language from that prompt's own prose, excluding quoted material, pasted transcripts, code and tool output. Never take the language from older prompts, agent explanations, previous verdicts or file contents. For example, an English request requires an English reason; a German request requires a German reason, even if all tool output is Spanish. Before returning JSON, check the reason's language and rewrite it if it does not match. Keep JSON keys and approve/deny values unchanged.`;

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  return content
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

export function constrainReviewPayload(
  payload: unknown,
  model: { provider: string; api?: string },
  goalCheck = false,
): unknown | undefined {
  if (
    model.provider !== "openai" ||
    !["openai-responses", "openai-completions"].includes(model.api ?? "")
  )
    return undefined;

  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Invalid reviewer provider payload");

  const body = payload as Record<string, unknown>;
  const format = {
    type: "json_schema",
    name: "approval_verdict",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "decision", "reason", ...(goalCheck ? ["blocked"] : [])],
      properties: {
        // parseVerdict binds the ID locally so this provider schema stays cacheable.
        requestId: { type: "string" },
        decision: { type: "string", enum: ["approve", "deny"] },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 600,
          description:
            "Explain the verdict in the language of latestUserPrompt's own operator prose, excluding quotations/code. The draft language and English policy text do not set this language. Quote offending draft words verbatim inside that explanation.",
        },
        ...(goalCheck ? { blocked: { type: "boolean" } } : {}),
      },
    },
  };

  if (model.api === "openai-completions") {
    const { type, ...json_schema } = format;

    return { ...body, response_format: { type, json_schema } };
  }

  return {
    ...body,
    text: { ...(body.text && typeof body.text === "object" ? body.text : {}), format },
  };
}

const verdictSchema = Type.Object(
  {
    requestId: Type.String(),
    decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")]),
    reason: Type.String({ minLength: 1, maxLength: 600 }),
  },
  { additionalProperties: false },
);

const goalVerdictSchema = Type.Object(
  { ...verdictSchema.properties, blocked: Type.Boolean() },
  { additionalProperties: false },
);

export type Verdict = Static<typeof verdictSchema> & { blocked?: boolean };

export function parseVerdict(text: string, requestId: string, goalCheck = false): Verdict {
  let verdict: unknown;

  try {
    verdict = JSON.parse(text);
  } catch {
    throw new Error("Reviewer returned invalid JSON; nothing executed");
  }

  if (!Check(goalCheck ? goalVerdictSchema : verdictSchema, verdict))
    throw new Error(
      `Reviewer verdict must contain exactly requestId, approve/deny decision, a reason of 1–600 characters${goalCheck ? ", and a boolean blocked flag" : ""}; nothing executed`,
    );

  if (verdict.requestId !== requestId)
    throw new Error("Reviewer verdict belongs to a different requestId; nothing executed");

  if (!verdict.reason.trim())
    throw new Error("Reviewer verdict has an empty reason; nothing executed");

  if ("blocked" in verdict && verdict.blocked && verdict.decision === "approve")
    throw new Error("A blocked goal cannot be approved; completion not confirmed");

  return verdict;
}

/** Race even if the provider fails to honor cancellation. No late approval can execute. */
export async function withWatchdog<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();

  const controller = new AbortController();
  let rejectAbort: (error: Error) => void = () => {};

  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });

  const abort = () => {
    controller.abort();
    rejectAbort(new Error(parent?.aborted ? "Approval cancelled" : "Reviewer request timed out"));
  };

  const closeDeadline = requestDeadline(controller.signal, timeoutMs, abort, parent);

  parent?.addEventListener("abort", abort, { once: true });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();

        return work(controller.signal);
      }),

      cancelled,
    ]);
  } finally {
    closeDeadline();
    parent?.removeEventListener("abort", abort);
    controller.abort();
  }
}
