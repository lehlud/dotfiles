import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import jobs from "../../jobs/index.ts";
import contextManagement from "../../context-management/index.ts";
import autoApproval from "../index.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { reviewedReceipts } from "../../shared/review/receipts.ts";
import { textContent } from "../../shared/review/protocol.ts";
import { writeConfigFixture } from "./config-fixture.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const command = (background = false) => ({
  tool: "container_exec",
  arguments: {
    argv: ["run", "--rm", "example.invalid/test", background ? "validate" : "independent"],
  },
  goal: "Validate the patch and review documentation",
  justification: "Bounded synthetic execution fixture",
  ...(background
    ? { background: { title: "Validation", work: "Review the independent documentation changes" } }
    : {}),
});
const call = (name: string, args: unknown) => [
  { type: "toolCall", id: crypto.randomUUID(), name, arguments: args },
];

async function fixture(script: (turn: number) => any[]) {
  const directory = await mkdtemp(join(tmpdir(), "pi-jobs-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;
  await writeConfigFixture(
    join(directory, "auto-approval.json"),
    JSON.stringify({
      reviewer: { provider: "jobs-fixture", model: "reviewer", thinking: "off" },
      recentUserPrompts: 2,
      sandbox: { backend: "bwrap" },
      requestTimeoutMs: 1000,
    }),
  );
  await writeFile(
    join(directory, "auto-approval.device.json"),
    JSON.stringify({
      sandbox: { executable: process.execPath, runnerExecutable: process.execPath },
    }),
  );

  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const contexts: any[] = [],
    reviews: any[] = [],
    errors: unknown[] = [];
  const release = deferred(),
    fourth = deferred(),
    third = deferred(),
    ended = deferred();
  let independent = false,
    cancelled = false;

  runtime.registerProvider("jobs-fixture", {
    api: "jobs-fixture",
    apiKey: "synthetic",
    baseUrl: "https://example.invalid",
    models: ["working", "reviewer"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      contextWindow: 65536,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      let content: any[];

      if (model.id === "reviewer") {
        const data = JSON.parse(
          textContent(context.messages.find((message) => message.role === "user")!.content),
        );

        reviews.push(data);
        content = [
          {
            type: "text",
            text: JSON.stringify({
              requestId: data.requestId,
              decision: "approve",
              reason: "Bounded synthetic job",
            }),
          },
        ];
      } else {
        contexts.push(structuredClone(context.messages));
        content = script(contexts.length);

        if (contexts.length === 3) third.resolve();

        if (contexts.length === 4) fourth.resolve();
      }

      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        timestamp: Date.now(),
        stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
        usage,
      };

      queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));

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
      autoApproval,
      jobs,
      contextManagement,
      (pi) => {
        pi.on("session_start", (_event, ctx) => {
          sessionServices(ctx).containers = {
            async prepare(request) {
              return {
                plan: { backend: "synthetic-container", requestedCommands: request.arguments },
                async assertCurrent() {},
                async execute(signal) {
                  if (request.background) {
                    await Promise.race([
                      release.promise,
                      new Promise<void>((resolve) =>
                        signal?.addEventListener(
                          "abort",
                          () => {
                            cancelled = true;
                            resolve();
                          },
                          { once: true },
                        ),
                      ),
                    ]);
                    signal?.throwIfAborted();
                  } else independent = true;

                  return {
                    content: [
                      {
                        type: "text",
                        text: request.background ? "VALIDATION-PASSED" : "INDEPENDENT-WORK-DONE",
                      },
                    ],
                    details: { exitCode: 0 },
                  };
                },
              };
            },
          };
        });
      },
    ],
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model: new ModelRegistry(runtime).find("jobs-fixture", "working")!,
    thinkingLevel: "off",
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    tools: ["approved_action", "job", "notes", "history", "new_context"],
  });

  await session.bindExtensions({
    mode: "json",
    onError: (error) => errors.push(error),
    uiContext: {
      setStatus() {},
      setWidget() {},
      notify(text: string, kind: string) {
        if (kind === "error") errors.push(text);
      },
    } as any,
  });
  session.subscribe((event) => {
    if (event.type === "agent_settled" && contexts.length >= 3) ended.resolve();
  });

  return {
    session,
    manager,
    contexts,
    reviews,
    errors,
    release,
    third,
    fourth,
    ended,
    independent: () => independent,
    cancelled: () => cancelled,
    async close() {
      await sessionServices({ sessionManager: manager }).cleanup?.();
      await session.abort();
      session.dispose();

      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;

      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("real SDK does independent approved work, then blocks in join with no further model calls", async () => {
  const state = await fixture((turn) =>
    turn === 1
      ? call("approved_action", command(true))
      : turn === 2
        ? call("approved_action", command())
        : turn === 3
          ? call("job", { operation: "wait" })
          : [{ type: "text", text: "Validation and documentation review complete." }],
  );

  try {
    const running = state.session.prompt(
      "Validate the patch and review the independent docs concurrently.",
    );

    await state.third.promise;
    // A real idle interval: the fixture makes no provider request while the tool waits.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(state.contexts).toHaveLength(3);
    expect(state.independent()).toBe(true);
    expect(state.reviews).toHaveLength(2);
    expect(state.reviews[0].sandboxPlan.managedBackground.maximumActiveJobs).toBe(4);
    state.release.resolve();
    await running;
    expect(state.contexts).toHaveLength(4);
    expect(state.errors).toEqual([]);
    expect(
      reviewedReceipts(state.manager.getBranch()).some((receipt) =>
        JSON.stringify(receipt.content).includes("VALIDATION-PASSED"),
      ),
    ).toBe(true);
    expect(
      state.manager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === "job-completion",
        ),
    ).toHaveLength(0);
  } finally {
    await state.close();
  }
});

test("real SDK automatically resumes an idle actor exactly once when a job finishes", async () => {
  const state = await fixture((turn) =>
    turn === 1
      ? call("approved_action", command(true))
      : [
          {
            type: "text",
            text:
              turn === 2
                ? "Independent review finished; waiting for automatic completion."
                : "Received the completed validation.",
          },
        ],
  );

  try {
    await state.session.prompt("Validate the patch while reviewing independent documentation.");
    expect(state.contexts).toHaveLength(2);
    expect(sessionServices({ sessionManager: state.manager }).jobs?.busy).toBe(true);
    state.release.resolve();
    await state.ended.promise;
    expect(state.contexts).toHaveLength(3);
    expect(state.errors).toEqual([]);
    expect(textContent(state.contexts[2].flatMap((message: any) => message.content))).toContain(
      "VALIDATION-PASSED",
    );
    expect(sessionServices({ sessionManager: state.manager }).jobs?.busy).toBe(false);
  } finally {
    await state.close();
  }
});

test("real SDK teardown cancels background dispatch before session cleanup returns", async () => {
  const state = await fixture((turn) =>
    turn === 1
      ? call("approved_action", command(true))
      : [{ type: "text", text: "Independent review finished." }],
  );

  try {
    await state.session.prompt("Validate the patch while reviewing docs.");
    await sessionServices({ sessionManager: state.manager }).cleanup?.();
    expect(state.cancelled()).toBe(true);
    expect(sessionServices({ sessionManager: state.manager }).jobs?.busy).toBe(false);
    expect(state.contexts).toHaveLength(2);
    expect(state.errors).toEqual([]);
  } finally {
    await state.close();
  }
});

test("real SDK sleeps between external observations without consuming model calls", async () => {
  const state = await fixture((turn) =>
    turn === 1
      ? call("job", { operation: "sleep", seconds: 1 })
      : [{ type: "text", text: "Observation interval elapsed." }],
  );

  try {
    const running = state.session.prompt(
      "Pause one second before continuing the external observation.",
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(state.contexts).toHaveLength(1);
    expect(state.reviews).toHaveLength(0);
    await running;
    expect(state.contexts).toHaveLength(2);
    expect(state.errors).toEqual([]);
  } finally {
    await state.close();
  }
});

test("real SDK steering wakes a long sleep and preserves the new user input", async () => {
  const state = await fixture((turn) =>
    turn === 1
      ? call("job", { operation: "sleep", seconds: 3600 })
      : [{ type: "text", text: "Handled the new steering." }],
  );

  try {
    const running = state.session.prompt("Pause before another external observation.");

    await new Promise((resolve) => setTimeout(resolve, 60));
    await state.session.prompt("Stop waiting; inspect the supplied correction instead.", {
      streamingBehavior: "steer",
    });
    await running;
    expect(state.contexts).toHaveLength(2);
    expect(JSON.stringify(state.contexts[1])).toContain("inspect the supplied correction");
    expect(state.errors).toEqual([]);
  } finally {
    await state.close();
  }
});

test("context rotation retains supervision and exposes running job IDs to the fresh projection", async () => {
  const state = await fixture((turn) =>
    turn === 1
      ? call("approved_action", command(true))
      : turn === 2
        ? call("notes", {
            operation: "set",
            key: "work",
            text: "Documentation review complete. Join the owned validation job shown in runtime metadata.",
          })
        : turn === 3
          ? call("new_context", {})
          : turn === 4
            ? call("job", { operation: "wait" })
            : [{ type: "text", text: "Received validation after context rotation." }],
  );

  try {
    const running = state.session.prompt(
      "Validate the patch while reviewing docs; rotate context if needed.",
    );

    await state.fourth.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.contexts).toHaveLength(4);
    expect(sessionServices({ sessionManager: state.manager }).jobs?.busy).toBe(true);
    expect(JSON.stringify(state.contexts[3])).toContain("Owned running jobs (runtime DATA)");
    expect(JSON.stringify(state.contexts[3])).not.toContain("request denied");
    state.release.resolve();
    await running;
    expect(state.contexts).toHaveLength(5);
    expect(state.errors).toEqual([]);
    expect(
      reviewedReceipts(state.manager.getBranch()).some((receipt) =>
        JSON.stringify(receipt.content).includes("VALIDATION-PASSED"),
      ),
    ).toBe(true);
  } finally {
    await state.close();
  }
});
