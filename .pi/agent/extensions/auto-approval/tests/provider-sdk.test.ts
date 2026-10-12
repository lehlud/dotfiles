import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ProviderAvailability } from "../../shared/providers/availability.ts";
import { registerProviderRecovery } from "../../shared/providers/stream.ts";

test("real Pi working streams retry once internally, retain one assistant entry and do not multiply SDK retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-provider-sdk-"));
  let now = 0,
    calls = 0,
    fail = 2;
  const availability = new ProviderAvailability({
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },

  });
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: false,
  });

  runtime.registerProvider("availability-sdk", {
    api: "availability-sdk",
    apiKey: "synthetic",
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
    streamSimple(model) {
      calls++;

      const stream = createAssistantMessageEventStream(),
        failed = fail-- > 0;
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [{ type: "text", text: failed ? "discarded partial" : "success" }],
        stopReason: failed ? "error" : "stop",
        errorMessage: failed
          ? "OpenAI API error (507): exceeded request buffer limit while retrying upstream"
          : undefined,
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };

      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });

        if (failed) stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: "stop", message });

      });

      return stream;
    },

  });

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [(pi) => registerProviderRecovery(pi, availability)],
  });

  await resourceLoader.reload();

  const model = new ModelRegistry(runtime).find("availability-sdk", "working")!;
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
    resourceLoader,
    noTools: "all",
  });

  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: { setStatus() {}, notify() {} } as any,
    });
    await session.prompt("Synthetic provider recovery check");
    expect(calls).toBe(3);

    const messages = session.sessionManager
      .getBranch()
      .filter(
        (entry: any) => entry.type === "message" && entry.message.role === "assistant",
      ) as any[];

    expect(messages).toHaveLength(1);
    expect(messages[0].message.content[0].text).toBe("success");
    expect(messages[0].message.usage.totalTokens).toBe(9);
    fail = 100;
    await session.prompt("Synthetic outage check");
    expect(calls).toBe(9);
    await session.prompt("Still in cooldown");
    expect(calls).toBe(9);
    now += 300000;
    await session.prompt("Single expired-cooldown probe");
    expect(calls).toBe(10);
    now += 300000;
    fail = 0;
    await session.prompt("Probe succeeds");
    expect(calls).toBe(11);
    fail = 100;
    await session.prompt("New outage gets five retries again");
    expect(calls).toBe(17);
  } finally {
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  }

}, 10000);
