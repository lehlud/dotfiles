import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { QuestionController } from "../../conversations/questions/controller.ts";
import { registerQuestionTools } from "../../conversations/questions/tools.ts";
import { registerOperatorInputs } from "../../conversations/operator-input.ts";
import { registerSteering } from "../../conversations/steering.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { operatorPromptRecords } from "../../shared/review/prompts.ts";

const tick = () => new Promise<void>((done) => setTimeout(done, 1));

async function until(check: () => boolean) {
  for (let index = 0; index < 3000 && !check(); index++) await tick();

  if (!check()) throw new Error("Question SDK fixture did not reach the expected state");
}

async function fixture(directory: string, mode: "answer" | "dismiss" | "withdraw") {
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: false,
  });
  const contexts: any[] = [];
  let controller!: QuestionController;
  let ctx: any;
  let release = () => {};

  runtime.registerProvider("questions-fixture", {
    api: "questions-fixture",
    apiKey: "synthetic",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "working",
        name: "Question fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 65536,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      contexts.push(structuredClone(context));

      const turn = contexts.length;
      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "stop",
        content: [{ type: "text", text: "Independent work continues." }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };

      if (turn === 1) {
        message.stopReason = "toolUse";
        message.content = [
          {
            type: "toolCall",
            id: "ask",
            name: "ask_user",
            arguments: {
              questions: [
                {
                  header: "Target",
                  question: "Which platform?",
                  options: [{ label: "Web" }, { label: "Desktop" }],
                },
              ],
            },
          },
        ];
      } else if (turn === 2 && mode === "withdraw") {
        const id = sessionServices(ctx).questions!("agent").list()[0].id;

        message.stopReason = "toolUse";
        message.content = [
          {
            type: "toolCall",
            id: "withdraw",
            name: "user_questions",
            arguments: { operation: "withdraw", ids: [id] },
          },
        ];
      }

      queueMicrotask(async () => {
        stream.push({ type: "start", partial: message });

        if (turn === 2 && mode !== "withdraw")
          await new Promise<void>((done) => {
            release = done;
          });

        stream.push({ type: "done", reason: message.stopReason, message });
      });

      return stream;
    },
  });

  const manager = SessionManager.inMemory(directory);
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => {
        controller = new QuestionController(pi);
        controller.register();
        registerQuestionTools(pi);
        registerOperatorInputs(pi);
        registerSteering(pi, () => undefined);
        pi.on("session_start", (_event, current) => {
          ctx = current;
        });
      },
    ],
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model: new ModelRegistry(runtime).find("questions-fixture", "working")!,
    thinkingLevel: "off",
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    tools: ["ask_user", "user_questions"],
  });

  await session.bindExtensions({ mode: "json" });

  return {
    session,
    contexts,
    controller,
    client: () => sessionServices(ctx).questions!("agent"),
    release: () => release(),
  };
}

for (const mode of ["answer", "dismiss", "withdraw"] as const) {
  test(`real Pi questions allow concurrent work and ${mode} without an external action`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-questions-sdk-"));
    let state: Awaited<ReturnType<typeof fixture>> | undefined;
    let work: Promise<void> | undefined;

    try {
      state = await fixture(directory, mode);
      work = state.session.prompt("Implement the client; preserve all existing constraints.");
      await until(() => state!.contexts.length >= 2);

      const question = state.client().list()[0];

      if (mode !== "withdraw") {
        expect(state.session.isStreaming).toBe(true);
        expect(question.status).toBe("pending");
        state.controller.respond([question.id], mode === "answer" ? "Desktop" : undefined);
        expect(state.session.isStreaming).toBe(true);
        state.release();
      }

      await work;

      const questions = state.client().list();
      const prompts = operatorPromptRecords(state.session.sessionManager.getBranch());

      expect(questions[0].status).toBe(
        mode === "answer" ? "answered" : mode === "dismiss" ? "dismissed" : "withdrawn",
      );
      expect(state.contexts.length).toBeGreaterThanOrEqual(3);
      expect(prompts).toHaveLength(mode === "answer" ? 2 : 1);

      if (mode === "answer") {
        expect(prompts.at(-1)?.text).toContain("\n\nDesktop");
        expect(prompts.at(-1)?.kind).toBe("steering");
      }

      const results = state.session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");

      expect(results.every((entry: any) => !entry.message.isError)).toBe(true);
      expect(results.map((entry: any) => entry.message.toolName)).not.toContain("approved_action");
    } finally {
      state?.release();
      await state?.session.abort();
      await work?.catch(() => {});
      state?.session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

