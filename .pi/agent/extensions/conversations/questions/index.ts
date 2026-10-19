import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QuestionController } from "./controller.ts";
import { registerQuestionTools } from "./tools.ts";

export function registerQuestions(pi: ExtensionAPI) {
  new QuestionController(pi).register();
  registerQuestionTools(pi);
}
