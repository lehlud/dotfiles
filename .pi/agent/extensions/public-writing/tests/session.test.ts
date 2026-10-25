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
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import publicWriting from "../index.ts";

test("real SDK keeps public-writing guidance current across tool turns without saving policy copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-writing-sdk-"));
  const contexts: string[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: false,
  });

  runtime.registerProvider("writing-fixture", {
    api: "writing-fixture",
    apiKey: "fixture",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "writer",
        name: "writer",
        reasoning: false,
        input: ["text"],
        contextWindow: 65536,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      contexts.push(JSON.stringify(context));

      const first = contexts.length === 1;
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: first ? "toolUse" : "stop",
        content: first
          ? [{ type: "toolCall", id: "checkpoint", name: "draft_checkpoint", arguments: {} }]
          : [{ type: "text", text: "The experimental exports failed validation." }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };

      queueMicrotask(() =>
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: response }),
      );

      return stream;
    },
  });

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
      publicWriting,
      (pi) =>
        pi.registerTool({
          name: "draft_checkpoint",
          label: "Fixture checkpoint",
          description: "Return fixture text without IO.",
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "Continue the draft." }], details: undefined };
          },
        }),
    ],
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model: new ModelRegistry(runtime).find("writing-fixture", "writer")!,
    sessionManager: SessionManager.inMemory(directory),
    settingsManager: settings,
    resourceLoader: loader,
    tools: ["draft_checkpoint"],
    thinkingLevel: "off",
  });

  try {
    await session.bindExtensions({ mode: "json" });
    await session.prompt("Write the experimental export README.");
    await session.prompt("Keep the deployment warning.");
    expect(contexts).toHaveLength(3);

    for (const context of contexts) {
      expect(
        context.split("Apply ONLY to newly authored/materially reworded public prose"),
      ).toHaveLength(2);
      expect(context).toContain("silently reread the changed paragraphs");
    }

    expect(JSON.stringify(session.sessionManager.getBranch())).not.toContain(
      "public-writing-policy",
    );
  } finally {
    await session.abort();
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
