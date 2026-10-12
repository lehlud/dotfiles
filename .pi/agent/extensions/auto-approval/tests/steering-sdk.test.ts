import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerSteering, STEERING_TYPE } from "../../conversations/steering.ts";
import { textContent } from "../../shared/review/protocol.ts";
import { registerContinue } from "../../conversations/continue.ts";

async function fixture(directory: string, outage = false) {
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: false,
  });
  let release: (() => void) | undefined,
    validations = 0;
  const contexts: any[] = [];

  runtime.registerProvider("steering-sdk-fixture", {
    api: "steering-sdk-fixture",
    apiKey: "test-fixture",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "working",
        name: "working",
        reasoning: false,
        input: ["text"],
        contextWindow: 65536,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const turn = contexts.push(structuredClone(context.messages));
      const content: any[] = [
        {
          type: "text",
          text:
            turn === 1
              ? "Hauptarbeit läuft."
              : turn === 2
                ? "Kommentarkorrektur erledigt; die Hauptprüfung folgt."
                : "MAIN-VALIDATION-COMPLETE",
        },
      ];

      if (turn === 2)
        content.push({
          type: "toolCall",
          id: "fixture-check",
          name: "validation_fixture",
          arguments: {},
        });

      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        timestamp: Date.now(),
        stopReason: outage && turn === 1 ? "error" : turn === 2 ? "toolUse" : "stop",
        ...(outage && turn === 1 ? { errorMessage: "Synthetic temporary provider outage" } : {}),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };

      queueMicrotask(async () => {
        if (turn === 1 && !outage)
          await new Promise<void>((done) => {
            release = done;
          });

        if (message.stopReason === "error")
          stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: message.stopReason, message });

      });

      return stream;
    },

  });

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [
      (pi) => {
        registerSteering(pi, () => undefined);
        registerContinue(pi);
      },

    ],
  });

  await resourceLoader.reload();

  const model = new ModelRegistry(runtime).find("steering-sdk-fixture", "working")!;
  const tool = {
    name: "validation_fixture",
    label: "Fixture",
    description: "Local test fixture, no filesystem or network actions",
    parameters: Type.Object({}),
    async execute() {
      validations++;

      return { content: [{ type: "text" as const, text: "MAIN-TESTS-PASSED" }], details: {} };
    },

  };
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
    resourceLoader,
    noTools: "builtin",
    customTools: [tool],
  });

  return { session, contexts, release: () => release?.(), validations: () => validations };
}

test("normal Pi steering carries its main task through the correction and subsequent tool turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-steering-sdk-"));
  const state = await fixture(directory);
  let main: Promise<void> | undefined;

  try {
    await state.session.bindExtensions({
      mode: "tui",
      uiContext: { setStatus() {}, notify() {} } as any,
    });

    const original = "Implementiere die Snail-Tests und validiere auch ihre Fehlerpfade.";
    const correction = "Unsere Kommentare sollen auf Deutsch sein.";

    main = state.session.prompt(original);

    for (let i = 0; i < 1000 && !state.contexts.length; i++)
      await new Promise<void>((done) => setTimeout(done, 1));

    expect(state.session.isStreaming).toBe(true);
    await state.session.prompt(correction, { streamingBehavior: "steer" });
    state.release();
    await main;
    expect(state.contexts).toHaveLength(3);
    expect(state.validations()).toBe(1);

    for (const messages of state.contexts.slice(1)) {
      const text = JSON.stringify(messages);

      expect(text).toContain(original);
      expect(text).toContain(correction);
      expect(text.match(/Finishing a correction alone/g)).toHaveLength(1);
    }

    expect(JSON.stringify(state.contexts.at(-1))).toContain("MAIN-TESTS-PASSED");

    const branch = state.session.sessionManager.getBranch();
    const users = branch.filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );

    expect(users).toHaveLength(2);
    expect(
      users.map((entry) =>
        entry.type === "message" && entry.message.role === "user"
          ? textContent(entry.message.content)
          : "",
      ),
    ).toEqual([original, correction]);
    expect(
      branch.some((entry) => entry.type === "custom_message" && entry.customType === STEERING_TYPE),
    ).toBe(false);
  } finally {
    state.release();
    await main?.catch(() => {});

    state.session.dispose();
    await rm(directory, { recursive: true, force: true });
  }

}, 10000);

test("real Pi /continue recovers a provider-interrupted task without a synthetic user prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-continue-sdk-"));
  const state = await fixture(directory, true);
  const notices: string[] = [];

  try {
    await state.session.bindExtensions({
      mode: "tui",
      uiContext: { notify: (text: string) => notices.push(text), setStatus() {} } as any,
    });
    await state.session.prompt(
      "Finish the original validation; preserve the existing constraints.",
    );
    expect(state.contexts).toHaveLength(1);
    expect(state.session.isStreaming).toBe(false);
    await state.session.prompt("/continue");

    for (let i = 0; i < 1000 && (state.contexts.length < 3 || state.session.isStreaming); i++)
      await new Promise<void>((done) => setTimeout(done, 1));

    expect(state.validations()).toBe(1);
    expect(state.contexts).toHaveLength(3);
    expect(notices).toContain("Continuing the current task.");

    const context = JSON.stringify(state.contexts.at(-1));

    expect(context).toContain("Finish the original validation");
    expect(context).toContain("The operator requests continuation");
    expect(context).not.toContain("/continue");
    expect(
      state.session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(1);
  } finally {
    await state.session.abort();
    state.session.dispose();
    await rm(directory, { recursive: true, force: true });
  }

}, 10000);
