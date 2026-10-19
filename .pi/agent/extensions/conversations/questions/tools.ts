import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sessionServices } from "../../shared/session/services.ts";
import type { UserQuestion } from "../../shared/contracts/questions.ts";
import { questionInputSchema } from "./store.ts";

function client(ctx: ExtensionToolContext) {
  const services = sessionServices(ctx);
  const owner = services.mailbox?.active() ? services.mailbox.name : "agent";
  const result = services.questions?.(owner);

  if (!result) throw new Error("User questions are unavailable in this session");

  return result;
}

function formatQuestion(question: UserQuestion): string {
  const lines = [`${question.id} · ${question.status} · ${question.header}`, question.question];

  for (const option of question.options ?? []) {
    const description = option.description ? `: ${option.description}` : "";

    lines.push(`- ${option.label}${description}`);
  }

  if (question.answer !== undefined) lines.push(`Operator answer: ${question.answer}`);

  return lines.join("\n");
}

function result(questions: UserQuestion[]) {
  const text = questions.length
    ? questions.map(formatQuestion).join("\n\n")
    : "No questions for this agent.";

  return { content: [{ type: "text" as const, text }], details: { questions } };
}

/** Bind identity once at peer creation; caller-supplied names cannot change the requester. */
export function bindPeerQuestions(
  parent: ExtensionContext,
  child: ExtensionContext,
  owner: string,
) {
  const questions = sessionServices(parent).questions?.(owner);

  sessionServices(child).questions = () => {
    if (!questions) throw new Error("User questions are unavailable in the parent session");

    return questions;
  };
}

/** Question metadata is internal; it cannot execute actions or supply operator answers. */
export function registerQuestionTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    exposure: "model-only",
    executionMode: "parallel",
    description:
      "Ask 1–3 clarification questions without waiting. The question panel replaces the operator's prompt editor until they answer, dismiss, or you withdraw all pending questions. Continue independent work. Answers and dismissals arrive automatically; do not poll. Use user_questions to withdraw obsolete questions. Ask only necessary questions; never request secrets or treat silence/dismissal as permission.",
    parameters: Type.Object(
      { questions: Type.Array(questionInputSchema, { minItems: 1, maxItems: 3 }) },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", `Ask user · ${args.questions?.length ?? 0} question(s)`),
        0,
        0,
      );
    },
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();

      return result(client(ctx).ask(args.questions));
    },
  });
  pi.registerTool({
    name: "user_questions",
    label: "User questions",
    exposure: "model-only",
    executionMode: "parallel",
    description:
      "List your questions and saved answers, or withdraw your own obsolete pending questions by ID. Withdrawal restores the normal prompt when no open questions remain. Do not poll repeatedly; user responses are delivered automatically. You cannot answer for the user or withdraw another agent's questions.",
    parameters: Type.Object(
      {
        operation: Type.Union([Type.Literal("list"), Type.Literal("withdraw")]),
        ids: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 }),
        ),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `User questions · ${args.operation}`), 0, 0);
    },
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();

      if (args.operation === "list" && args.ids) throw new Error("Listing questions takes no IDs");

      if (args.operation === "withdraw" && !args.ids)
        throw new Error("Withdrawal requires question IDs");

      const service = client(ctx);

      return result(args.operation === "list" ? service.list() : service.withdraw(args.ids!));
    },
  });
}
