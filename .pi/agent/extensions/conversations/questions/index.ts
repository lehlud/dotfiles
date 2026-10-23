import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuestionController } from "./controller.ts";
import { registerQuestionTools } from "./tools.ts";

export function registerQuestions(
  pi: ExtensionAPI,
  installComposer?: (ctx: ExtensionContext) => () => void,
) {
  new QuestionController(pi, installComposer).register();
  registerQuestionTools(pi);
}
