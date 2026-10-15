import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { registerGoals } from "../../conversations/goals.ts";
import { registerProgress, PROGRESS_WARNING } from "../../conversations/progress.ts";

for (const changing of [false, true])
  test(`real SDK ${changing ? "continues meaningful new inspections" : "pauses unchanged tool loops before another model call"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-progress-sdk-")),
      previous = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = directory;

    let working = 0,
      reviews = 0,
      results = 0;
    const contexts: string[] = [];
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "models.json"),
      modelsStorePath: join(directory, "models-store.json"),
      allowModelNetwork: false,
    });

    await writeFile(
      join(directory, "auto-approval.json"),
      JSON.stringify({
        reviewers: [{ provider: "progress-fixture", model: "reviewer", thinking: "off" }],
        recentUserPrompts: 2,
        requestTimeoutMs: 1000,
        sandbox: { backend: "bwrap" },
      }),
    );
    await writeFile(
      join(directory, "auto-approval.device.json"),
      JSON.stringify({
        sandbox: { executable: process.execPath, runnerExecutable: process.execPath },
      }),
    );
    runtime.registerProvider("progress-fixture", {
      api: "progress-fixture",
      apiKey: "synthetic",
      baseUrl: "https://example.invalid",
      models: ["working", "reviewer"].map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
      streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          timestamp: Date.now(),
          stopReason: "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };

        if (model.id === "reviewer") {
          reviews++;

          const request = JSON.parse(
            String(context.messages.find((entry) => entry.role === "user")?.content),
          );

          message.content = [
            {
              type: "text",
              text: JSON.stringify({
                requestId: request.requestId,
                decision: "approve",
                reason: "Synthetic completion evidence.",
              }),
            },
          ];
        } else {
          contexts.push(JSON.stringify(context.messages));
          working++;

          if (working > 20) message.content = [{ type: "text", text: "Fixture complete." }];
          else {
            message.stopReason = "toolUse";
            message.content = [
              {
                type: "toolCall",
                id: `inspect-${working}`,
                name: "approved_action",
                arguments: {
                  tool: "bash",
                  arguments: {
                    command:
                      working % 2
                        ? "git status --short; sha256sum accepted"
                        : "sha256sum accepted; git status --short",
                  },
                  goal: "Inspect task evidence",
                  justification: "Synthetic repeated inspection",
                },
              },
            ];
          }

        }

        queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));

        return stream;
      },
    });

    const settings = SettingsManager.inMemory(),
      manager = SessionManager.inMemory(directory);
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
          registerGoals(pi);
          registerProgress(pi);
          pi.registerTool({
            name: "approved_action",
            label: "Synthetic reviewed inspection",
            description: "Fixture only; no host execution",
            parameters: Type.Object({
              tool: Type.String(),
              arguments: Type.Object({ command: Type.String() }),
              goal: Type.String(),
              justification: Type.String(),
            }),
            async execute(_id, args) {
              results++;

              return {
                content: [
                  { type: "text", text: `Approval display ${results}` },
                  {
                    type: "text",
                    text: changing ? `hash-${results}  accepted` : "stable-hash  accepted",
                  },
                ],
                details: { approval: { decision: "approve", action: args } },
              };
            },
          });
        },
      ],
    });

    await loader.reload();

    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model: new ModelRegistry(runtime).find("progress-fixture", "working")!,
      thinkingLevel: "off",
      sessionManager: manager,
      settingsManager: settings,
      resourceLoader: loader,
      tools: ["approved_action"],
    });

    try {
      await session.bindExtensions({
        mode: "tui",
        uiContext: { setStatus() {}, notify() {} } as any,
      });
      await session.prompt("/goal Inspect and finish the fixture");

      for (let i = 0; i < 3000; i++) {
        const state = manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "auto-approval-goal")
          .at(-1) as any;

        if (!session.isStreaming && state?.data.status === (changing ? "complete" : "paused"))
          break;

        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      const branch = manager.getBranch(),
        state = branch
          .filter((entry) => entry.type === "custom" && entry.customType === "auto-approval-goal")
          .at(-1) as any;

      expect(state.data.status).toBe(changing ? "complete" : "paused");
      expect(results).toBe(changing ? 20 : 9);
      expect(reviews).toBe(changing ? 1 : 0);
      expect(contexts.some((context) => context.includes(PROGRESS_WARNING))).toBe(!changing);
      expect(
        branch.filter(
          (entry) => entry.type === "custom" && entry.customType === "conversation-progress-halt",
        ),
      ).toHaveLength(changing ? 0 : 1);
    } finally {
      await session.abort();
      session.dispose();

      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;

      await rm(directory, { recursive: true, force: true });
    }

  }, 10000);

