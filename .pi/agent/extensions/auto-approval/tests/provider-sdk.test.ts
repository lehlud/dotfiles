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
import { reviewAction, buildReview } from "../review.ts";
import { registerProviderRecovery } from "../../shared/providers/stream.ts";
import { expiredTokenResponse } from "./provider-error-fixtures.ts";
import { registerContinue } from "../../conversations/continue.ts";

const modulePath = "../../shared/providers/availability.ts?standby-sdk-copy";
const other: typeof import("../../shared/providers/availability.ts") = await import(modulePath);

for (const [label, failure] of [
  ["507", "OpenAI API error (507): exceeded request buffer limit while retrying upstream"],
  ["coded token expiry", expiredTokenResponse],
]) {
  test(`real Pi ${label} recovery retains one assistant entry and does not multiply SDK retries`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-provider-sdk-"));
    let now = 0,
      calls = 0,
      fail = 2;
    const delays: number[] = [];
    let hold = false,
      waiting!: () => void;
    const paused = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    let realDelay = false;
    const availability = new other.ProviderAvailability({
      now: () => now,
      wait: async (ms, signal) => {
        delays.push(ms);
        now += ms;

        if (realDelay) await new Promise((resolve) => setTimeout(resolve, 80));

        if (hold) {
          waiting();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
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
      streamSimple(model, context) {
        calls++;

        const stream = createAssistantMessageEventStream(),
          failed = fail-- > 0;
        let requestId: string | undefined;

        try {
          requestId = JSON.parse(
            String(context.messages.find((entry) => entry.role === "user")?.content),
          ).requestId;
        } catch {}

        const success = requestId
          ? JSON.stringify({ requestId, decision: "approve", reason: "Synthetic safe action" })
          : "success";
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: [{ type: "text", text: failed ? "discarded partial" : success }],
          stopReason: failed ? "error" : "stop",
          errorMessage: failed ? failure : undefined,
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
      extensionFactories: [
        (pi) => {
          registerProviderRecovery(pi, availability);
          registerContinue(pi);
        },
      ],
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
      fail = 13;

      const before = delays.length;

      await session.prompt("Recover automatically through every retry level.");
      expect(calls).toBe(17);
      expect(delays.slice(before)).toEqual([
        15000, 15000, 60000, 150000, 300000, 300000, 300000, 900000, 900000, 900000, 1800000,
        1800000, 1800000,
      ]);
      fail = 1;
      await session.prompt("A subsequent outage starts at the first level again.");
      expect(calls).toBe(19);
      expect(delays.at(-1)).toBe(15000);
      hold = true;
      fail = Infinity;

      const pending = session.prompt("Cancel this pending recovery and resume the same task.");

      await paused;
      expect(calls).toBe(20);
      await session.abort();
      await pending;
      expect(session.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
      hold = false;
      fail = 0;

      let completed!: () => void;
      const resumed = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_end") completed();
      });

      try {
        await session.prompt("/continue");
        await resumed;
      } finally {
        unsubscribe();
      }

      expect(calls).toBe(21);
      expect(session.messages.at(-1)).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "success" }],
      });
      fail = 1;
      realDelay = true;

      const selected = { provider: "availability-sdk", model: "working", thinking: "off" as const };
      const config: any = {
        reviewer: selected,
        requestTimeoutMs: 30,
        recentUserPrompts: 2,
        sandbox: { backend: "bwrap" },
      };
      const envelope = buildReview(
        {
          tool: "read",
          arguments: { path: "sample.txt" },
          goal: "Read the sample",
          justification: "Synthetic validation",
        },
        [{ type: "message", message: { role: "user", content: "Read the sample safely." } }],
        config,
        directory,
        [],
      );
      const checked = await reviewAction(
        config,
        new ModelRegistry(runtime),
        envelope,
        { start() {}, finish() {}, failed() {} },
        undefined,
        undefined,
        availability,
      );

      expect(checked.verdict.decision).toBe("approve");
      expect(calls).toBe(23);
    } finally {
      session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);
}

