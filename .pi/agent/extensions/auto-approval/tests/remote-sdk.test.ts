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
import remote from "../../remote/index.ts";

// No network/model calls: saved operator consent is synthetic, and no project tool executes.
test("native Pi restores remote context and /remote off without sending commands to the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-sdk-"));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const contexts: any[] = [],
    errors: string[] = [],
    statuses: string[] = [];

  runtime.registerProvider("remote-fixture", {
    api: "openai-completions",
    apiKey: "synthetic",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "working",
        name: "Working",
        reasoning: false,
        input: ["text"],
        contextWindow: 65536,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      contexts.push(context);

      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };

      stream.push({ type: "done", reason: "stop", message });
      stream.end();

      return stream;
    },
  });

  const manager = SessionManager.inMemory(directory);

  manager.appendCustomEntry("remote-workspace", {
    user: "synthetic",
    host: "remote.example",
    folder: "project",
    root: "/home/synthetic/project",
    isolation: "confirmed-account",
    knownHosts: "synthetic-public-key",
    confirmation: { source: "operator-ui", reason: "Synthetic saved consent" },
  });

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [remote],
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model: new ModelRegistry(runtime).find("remote-fixture", "working")!,
    settingsManager,
    sessionManager: manager,
    resourceLoader: loader,
    tools: [],
  });

  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        notify: () => {},
        setStatus: (_key: string, text?: string) => {
          if (text) statuses.push(text);
        },
      } as any,
      onError: (event) => errors.push(event.error),
    });
    await session.prompt("Inspect the selected workspace context.");
    expect(JSON.stringify(contexts[0])).toContain(
      "Operator-selected remote workspace: synthetic@remote.example:/home/synthetic/project",
    );
    expect(statuses).toContain("remote: synthetic@remote.example:project");
    await session.prompt("/remote off");
    expect(contexts).toHaveLength(1);
    expect(
      manager
        .getBranch()
        .filter((entry: any) => entry.customType === "remote-workspace")
        .at(-1),
    ).toMatchObject({ data: null });
    await session.prompt("Continue locally.");
    expect(JSON.stringify(contexts[1])).not.toContain("Operator-selected remote workspace:");
    expect(errors).toEqual([]);
  } finally {
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
