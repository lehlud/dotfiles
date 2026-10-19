import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const QUESTION_TOOLS = ["ask_user", "user_questions"] as const;

export type QuestionInput = {
  header: string;
  question: string;
  options?: { label: string; description?: string }[];
};

export type UserQuestion = QuestionInput & {
  id: string;
  owner: string;
  status: "pending" | "answered" | "dismissed" | "withdrawn";
  answer?: string;
};

export type QuestionClient = {
  ask(questions: QuestionInput[]): UserQuestion[];
  list(): UserQuestion[];
  withdraw(ids: string[]): UserQuestion[];
};

export function availableQuestionTools(pi: ExtensionAPI): string[] {
  const names = new Set(pi.getAllTools?.().map((tool) => tool.name));

  return QUESTION_TOOLS.filter((name) => names.has(name));
}
