import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { QuestionInput, UserQuestion } from "../../shared/contracts/questions.ts";

export const QUESTION_ENTRY = "conversation-question";
export const questionInputSchema = Type.Object(
  {
    header: Type.String({ minLength: 1, maxLength: 40 }),
    question: Type.String({ minLength: 1, maxLength: 2000 }),
    options: Type.Optional(
      Type.Array(
        Type.Object(
          {
            label: Type.String({ minLength: 1, maxLength: 100 }),
            description: Type.Optional(Type.String({ maxLength: 300 })),
          },
          { additionalProperties: false },
        ),
        { minItems: 2, maxItems: 5 },
      ),
    ),
  },
  { additionalProperties: false },
);
const storedSchema = Type.Object(
  {
    ...questionInputSchema.properties,
    id: Type.String({ minLength: 1, maxLength: 100 }),
    owner: Type.String({ minLength: 1, maxLength: 100 }),
    status: Type.Literal("pending"),
  },
  { additionalProperties: false },
);
const eventSchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("ask"),
      questions: Type.Array(storedSchema, { minItems: 1, maxItems: 3 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Union([
        Type.Literal("answered"),
        Type.Literal("dismissed"),
        Type.Literal("withdrawn"),
      ]),
      ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 }),
      answer: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
    },
    { additionalProperties: false },
  ),
]);

type Event =
  | { operation: "ask"; questions: UserQuestion[] }
  | {
      operation: "answered" | "dismissed" | "withdrawn";
      ids: string[];
      answer?: string;
    };

/** A persisted transition succeeds before it changes the visible question queue. */
export class QuestionStore {
  private records = new Map<string, UserQuestion>();

  constructor(private persist: (event: Event) => void) {}

  restore(events: unknown[]) {
    for (const event of events) {
      if (Check(eventSchema, event)) this.apply(event as Event);
    }
  }

  list(owner?: string): UserQuestion[] {
    return structuredClone(
      [...this.records.values()].filter((question) => !owner || question.owner === owner),
    );
  }

  pending(): UserQuestion[] {
    return structuredClone(
      [...this.records.values()].filter((question) => question.status === "pending"),
    );
  }

  ask(owner: string, inputs: QuestionInput[]): UserQuestion[] {
    if (
      !inputs.length ||
      inputs.length > 3 ||
      inputs.some((input) => !Check(questionInputSchema, input))
    ) {
      throw new Error("Ask one to three bounded questions with an optional choice list");
    }

    if (inputs.some((input) => !input.header.trim() || !input.question.trim()))
      throw new Error("Question text cannot be blank");

    const pending = this.pending();
    const created: UserQuestion[] = [];
    const questions = inputs.map((input): UserQuestion => {
      const existing = [...pending, ...created].find(
        (question) =>
          question.owner === owner &&
          question.header === input.header &&
          question.question === input.question &&
          JSON.stringify(question.options) === JSON.stringify(input.options),
      );

      if (existing) return existing;

      const question: UserQuestion = {
        ...structuredClone(input),
        id: randomUUID(),
        owner,
        status: "pending",
      };

      created.push(question);

      return question;
    });

    if (pending.length + created.length > 12)
      throw new Error("Resolve or withdraw pending questions before asking more");

    if (created.length) this.commit({ operation: "ask", questions: created });

    return structuredClone([
      ...new Map(questions.map((question) => [question.id, question] as const)).values(),
    ]);
  }

  resolve(
    ids: string[],
    status: "answered" | "dismissed" | "withdrawn",
    answer?: string,
    owner?: string,
  ): UserQuestion[] {
    if (!ids.length || ids.length > 12 || new Set(ids).size !== ids.length)
      throw new Error("Select distinct question IDs");

    for (const id of ids) {
      const question = this.records.get(id);

      if (!question || (owner && question.owner !== owner))
        throw new Error("Unknown question for this agent");

      if (question.status !== "pending") throw new Error("Question is no longer pending");
    }

    if (status === "answered" && (ids.length !== 1 || !answer?.trim() || answer.length > 8000))
      throw new Error("Provide an answer of 1–8000 characters");

    this.commit({ operation: status, ids, ...(status === "answered" ? { answer } : {}) });

    return ids.map((id) => structuredClone(this.records.get(id)!));
  }

  private commit(event: Event) {
    if (!Check(eventSchema, event)) throw new Error("Invalid question transition");

    this.persist(structuredClone(event));
    this.apply(event);
  }

  private apply(event: Event) {
    if (event.operation === "ask") {
      for (const question of event.questions) {
        if (!this.records.has(question.id))
          this.records.set(question.id, structuredClone(question));
      }
    } else {
      for (const id of event.ids) {
        const question = this.records.get(id);

        if (question?.status === "pending") {
          question.status = event.operation;

          if (event.operation === "answered") question.answer = event.answer;
        }
      }
    }

    for (const [id, question] of this.records) {
      if (this.records.size <= 128) break;

      if (question.status !== "pending") this.records.delete(id);
    }
  }
}
