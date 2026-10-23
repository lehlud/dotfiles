import { writeConfigFixture } from "./config-fixture.ts";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import autoApproval from "../index.ts";
import { registerGoals } from "../../conversations/goals.ts";
import { registerContinue } from "../../conversations/continue.ts";
import codeQuality from "../../code-quality/index.ts";
import contextManagement from "../../context-management/index.ts";
import { textContent } from "../../shared/review/protocol.ts";
import { registerSteering, STEERING_TYPE } from "../../conversations/steering.ts";
import type { Goal } from "../../shared/contracts/goal.ts";

async function fixture(
  directory: string,
  {
    steering = false,
    selfAssigned = false,
    externalBlocker = false,
    pressure = false,
  }: {
    steering?: boolean;
    selfAssigned?: boolean;
    externalBlocker?: boolean;
    pressure?: boolean | number;
  } = {},
) {
  const usedTokens = typeof pressure === "number" ? pressure : 52000;

  await writeConfigFixture(
    join(directory, "auto-approval.json"),
    JSON.stringify({
      reviewer: { provider: "goal-sdk-fixture", model: "reviewer", thinking: "off" },
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

  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: false,
  });
  const contexts: any[] = [];
  let release: (() => void) | undefined,
    workingTurns = 0;

  runtime.registerProvider("goal-sdk-fixture", {
    api: "goal-sdk-fixture",
    apiKey: "test-fixture",
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

      contexts.push({ model: model.id, messages: structuredClone(context.messages) });

      const data =
        model.id === "reviewer"
          ? JSON.parse(
              textContent(context.messages.find((entry) => entry.role === "user")!.content),
            )
          : undefined;
      const incomplete =
        externalBlocker ||
        (pressure && workingTurns < 2) ||
        (steering &&
          data &&
          !data.assistantAnswers.some((entry: any) =>
            entry.text.includes("MAIN-VALIDATION-COMPLETE"),
          ));
      const turn = data ? 0 : ++workingTurns;
      const text = data
        ? JSON.stringify({
            requestId: data.requestId,
            decision: incomplete ? "deny" : "approve",
            blocked: externalBlocker,
            reason: incomplete
              ? "Die ursprüngliche Validierung fehlt noch."
              : "Das Ergebnis liegt vor.",
          })
        : steering
          ? [
              "",
              "Hauptarbeit läuft.",
              "Kommentarkorrektur fertig.",
              "MAIN-VALIDATION-COMPLETE: Hauptprüfung abgeschlossen.",
            ][turn]
          : "Das gespeicherte Ziel wurde fortgesetzt.";
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text }],
        timestamp: Date.now(),
        stopReason: "stop",
        usage: {
          input: pressure && model.id === "working" ? usedTokens : 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: pressure && model.id === "working" ? usedTokens : 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };

      if (selfAssigned && turn === 1) {
        message.content = [
          {
            type: "toolCall",
            id: "self-goal",
            name: "set_goal",
            arguments: { goal: "Explain the supplied result" },
          },
        ];
        message.stopReason = "toolUse";
      }

      queueMicrotask(async () => {
        if (steering && turn === 1)
          await new Promise<void>((done) => {
            release = done;
          });

        stream.push({ type: "done", reason: message.stopReason, message });
      });

      return stream;
    },
  });

  const sessionManager = SessionManager.inMemory(directory);

  if (!selfAssigned) {
    sessionManager.appendCustomEntry("auto-approval-operator-prompt", {
      goalId: "saved-goal",
      text: "Erkläre das gespeicherte Prüfergebnis.",
    });
    sessionManager.appendCustomEntry("auto-approval-goal", {
      id: "saved-goal",
      text: "Erkläre das gespeicherte Prüfergebnis.",
      status: "paused",
      checks: 1,
      reason: "Interrupted by operator; use /goal resume",
    });
    sessionManager.appendCustomEntry("auto-approval-goal-review", {
      goalId: "saved-goal",
      verdict: { decision: "deny", reason: "Erkläre noch das Testergebnis." },
    });
    sessionManager.appendCustomMessageEntry(
      "auto-approval-goal-instruction",
      "Operator goal: obsolete\nMissing work: use /goal resume",
      false,
    );
    sessionManager.appendCustomMessageEntry("unrelated-fixture", "KEEP-UNRELATED-CONTEXT", false);
  }

  const settingsManager = SettingsManager.inMemory(
    pressure ? { compaction: { enabled: false } } : {},
  );
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
        if (selfAssigned) autoApproval(pi);

        registerSteering(pi, registerGoals(pi));
        registerContinue(pi);
        codeQuality(pi);

        if (pressure) contextManagement(pi);
      },
    ],
  });

  await resourceLoader.reload();

  const model = new ModelRegistry(runtime).find("goal-sdk-fixture", "working")!;
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    sessionManager,
    settingsManager,
    resourceLoader,
    noTools: selfAssigned ? undefined : "all",
    tools: selfAssigned ? ["set_goal"] : undefined,
  });

  return {
    session,
    contexts,
    release: () => release?.(),
    unblock: () => {
      externalBlocker = false;
    },
  };
}

test("real Pi waits on an independent blocker without starting another work or review turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-blocker-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  const state = await fixture(directory, { externalBlocker: true });
  const notices: string[] = [];

  try {
    await state.session.bindExtensions({
      mode: "tui",
      uiContext: { setStatus() {}, notify: (text: string) => notices.push(text) } as any,
    });
    await state.session.prompt("/goal resume");

    for (let i = 0; i < 1000 && !notices.some((text) => text.startsWith("Goal waiting:")); i++)
      await new Promise<void>((done) => setTimeout(done, 1));

    expect(notices.some((text) => text.startsWith("Goal waiting:"))).toBe(true);
    expect(state.contexts.filter((entry) => entry.model === "working")).toHaveLength(1);
    expect(state.contexts.filter((entry) => entry.model === "reviewer")).toHaveLength(1);

    const goals = () =>
      state.session.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "custom" && entry.customType === "auto-approval-goal"
            ? [entry.data as Goal]
            : [],
        );

    expect(goals().at(-1)?.status).toBe("paused");
    expect(notices.some((text) => text.startsWith("Goal confirmed:"))).toBe(false);
    state.unblock();
    await state.session.prompt("/continue");

    for (let i = 0; i < 1000 && !notices.some((text) => text.startsWith("Goal confirmed:")); i++)
      await new Promise<void>((done) => setTimeout(done, 1));

    expect(goals().at(-1)?.status).toBe("complete");
    expect(state.contexts.filter((entry) => entry.model === "working")).toHaveLength(2);
    expect(state.contexts.filter((entry) => entry.model === "reviewer")).toHaveLength(2);
  } finally {
    state.session.dispose();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
});

for (const command of ["/goal resume", "/continue"]) {
  test(`real Pi SDK ${command} resumes a legacy goal with one task instruction and no raw command`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-goal-sdk-"));
    const previous = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = directory;

    const { session, contexts } = await fixture(directory);
    const notices: string[] = [];

    try {
      await session.bindExtensions({
        mode: "tui",
        uiContext: { setStatus() {}, notify: (text: string) => notices.push(text) } as any,
      });

      const original = structuredClone(session.sessionManager.getBranch());

      await session.prompt(command);

      for (let i = 0; i < 1000 && !notices.some((text) => text.startsWith("Goal confirmed:")); i++)
        await new Promise<void>((done) => setTimeout(done, 1));

      expect(notices.join("\n")).toContain("Goal resumed:");
      expect(notices.join("\n")).toContain("Goal confirmed:");

      const working = contexts.filter((entry) => entry.model === "working");

      expect(working).toHaveLength(1);

      const input = JSON.stringify(working[0].messages);

      expect(input).toContain("Erkläre das gespeicherte Prüfergebnis.");
      expect(input).toContain("Erkläre noch das Testergebnis.");
      expect(input.match(/Operator goal:/g)).toHaveLength(1);
      expect(input).not.toContain("/goal resume");
      expect(input).not.toContain("/continue");
      expect(input.split("Code readability is a standing requirement").length - 1).toBe(1);
      expect(input).not.toContain("obsolete");
      expect(input).toContain("KEEP-UNRELATED-CONTEXT");
      expect(session.sessionManager.getBranch().slice(0, original.length)).toEqual(original);
      expect(
        session.sessionManager
          .getBranch()
          .some((entry) => entry.type === "message" && entry.message.role === "user"),
      ).toBe(false);
      await session.reload();
      await session.prompt("/goal status");
      expect(notices.at(-1)).toContain("No goal.");
      await session.prompt("Unrelated follow-up after completion");

      const followUp = contexts.filter((entry) => entry.model === "working").at(-1);

      expect(JSON.stringify(followUp.messages)).not.toContain("Operator goal:");
      expect(JSON.stringify(followUp.messages)).toContain("KEEP-UNRELATED-CONTEXT");
      expect(contexts.filter((entry) => entry.model === "reviewer")).toHaveLength(1);
    } finally {
      session.dispose();

      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;

      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);
}

test("real steering keeps a goal running after a correction until the original work passes review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-steering-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  const state = await fixture(directory, { steering: true });
  const notices: string[] = [];

  try {
    await state.session.bindExtensions({
      mode: "tui",
      uiContext: { setStatus() {}, notify: (text: string) => notices.push(text) } as any,
    });
    await state.session.prompt("/goal resume");

    for (let i = 0; i < 1000 && !state.contexts.length; i++)
      await new Promise<void>((done) => setTimeout(done, 1));

    expect(state.session.isStreaming).toBe(true);
    await state.session.prompt("Unsere neuen Kommentare bitte auf Deutsch.", {
      streamingBehavior: "steer",
    });
    state.release();

    for (let i = 0; i < 1000 && !notices.some((text) => text.startsWith("Goal confirmed:")); i++)
      await new Promise<void>((done) => setTimeout(done, 1));

    expect(notices.join("\n")).toContain("Goal incomplete:");
    expect(notices.join("\n")).toContain("Goal confirmed:");

    const work = state.contexts.filter((entry) => entry.model === "working");

    expect(work).toHaveLength(3);

    for (const entry of work.slice(1)) {
      const text = JSON.stringify(entry.messages);

      expect(text).toContain("Unsere neuen Kommentare bitte auf Deutsch.");
      expect(text).toContain("Erkläre das gespeicherte Prüfergebnis.");
      expect(text).toContain("Finishing a correction alone does not finish the whole task");
    }

    const goals = state.session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "auto-approval-goal");

    expect(
      goals.some((entry: any) => entry.data.status === "running" && entry.data.checks === 2),
    ).toBe(true);
    expect((goals.at(-1) as any).data.status).toBe("complete");
    expect(
      state.session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom_message" && entry.customType === STEERING_TYPE),
    ).toBe(false);
  } finally {
    state.release();
    await state.session.abort();
    state.session.dispose();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("real Pi accepts repeated goal changes during a live run without raw commands or a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-live-goal-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  const { session, contexts, release } = await fixture(directory, { steering: true });
  let running: Promise<void> | undefined;

  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: { setStatus() {}, notify() {} } as any,
    });
    running = session.prompt("Migrate the parser and validate the result.");

    for (let i = 0; i < 1000 && !contexts.length; i++) await Bun.sleep(1);

    expect(session.isStreaming).toBe(true);
    await session.prompt("/goal First target");
    await session.prompt("/goal Validate the complete migration");
    expect(session.isStreaming).toBe(true);
    release();
    await running;

    const saved = session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "auto-approval-goal")
      .at(-1) as any;

    expect(saved.data.text).toBe("Validate the complete migration");
    expect(saved.data.status).toBe("complete");

    const later = contexts.filter((context) => context.model === "working").slice(1);

    expect(later.length).toBeGreaterThan(0);

    for (const context of later) {
      const input = JSON.stringify(context.messages);

      expect(input.match(/Operator goal:/g)).toHaveLength(1);
      expect(input).toContain("Validate the complete migration");
      expect(input).not.toContain("Operator goal: First target");
      expect(input).not.toContain("/goal Validate");
    }
  } finally {
    release();
    await session.abort();
    await running?.catch(() => {});
    session.dispose();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
});

test("real Pi drops a goal during streaming without stopping work or restoring the goal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-drop-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  const { session, contexts, release } = await fixture(directory, { steering: true });
  const notices: string[] = [];
  const statuses = new Map<string, string>();

  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        notify: (text: string) => notices.push(text),
        setStatus: (key: string, text?: string) =>
          text === undefined ? statuses.delete(key) : statuses.set(key, text),
      } as any,
    });
    await session.prompt("/goal resume");

    for (let i = 0; i < 1000 && !contexts.length; i++) await Bun.sleep(1);

    expect(session.isStreaming).toBe(true);
    await session.prompt("/goal drop");
    expect(session.isStreaming).toBe(true);
    expect(statuses.has("01-goal")).toBe(false);
    release();

    for (let i = 0; i < 1000 && session.isStreaming; i++) await Bun.sleep(1);

    expect(session.isStreaming).toBe(false);
    expect(contexts.filter((entry) => entry.model === "working")).toHaveLength(1);
    expect(contexts.filter((entry) => entry.model === "reviewer")).toHaveLength(0);
    await session.reload();
    await session.prompt("/goal status");
    expect(notices.at(-1)).toContain("No goal.");
    await session.prompt("/goal resume");
    expect(notices.at(-1)).toContain("No paused goal");
    await session.prompt("Continue the ordinary task without goal tracking");

    const followUp = contexts.filter((entry) => entry.model === "working").at(-1);

    expect(JSON.stringify(followUp.messages)).not.toContain("Operator goal:");
    expect(JSON.stringify(followUp.messages)).not.toContain("/goal drop");
    expect(contexts.filter((entry) => entry.model === "reviewer")).toHaveLength(0);
  } finally {
    release();
    await session.abort();
    session.dispose();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
});

test("a real working model can set its own goal without an action review or forged operator intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-goal-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  const { session, contexts } = await fixture(directory, { selfAssigned: true });

  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: { setStatus() {}, setWidget() {}, notify() {} } as any,
    });
    await session.prompt("Explain the supplied result; never upload source.");

    const branch = session.sessionManager.getBranch();
    const result = branch.find(
      (entry: any) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "set_goal",
    ) as any;

    expect(result.message.isError).toBe(false);
    expect(result.message.details.goal.source).toBe("agent");
    expect(branch.some((entry: any) => entry.customType === "auto-approval-operator-prompt")).toBe(
      false,
    );
    expect(branch.some((entry: any) => entry.customType === "auto-approval-review")).toBe(false);

    const reviews = contexts.filter((context) => context.model === "reviewer");

    expect(reviews).toHaveLength(1);

    const data = JSON.parse(
      textContent(reviews[0].messages.find((entry: any) => entry.role === "user").content),
    );

    expect(data.operatorGoal).toBeUndefined();
    expect(data.goal).toEqual({ text: "Explain the supplied result", source: "agent" });
    expect(data.userPrompts).toEqual(["Explain the supplied result; never upload source."]);

    const saved = branch
      .filter((entry: any) => entry.customType === "auto-approval-goal")
      .at(-1) as any;

    expect(saved.data.status).toBe("complete");
  } finally {
    session.dispose();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
});

test("goal continuation survives context pressure when there are no tool outputs to evict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-context-pressure-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  const { session, contexts } = await fixture(directory, { pressure: true });
  const errors: unknown[] = [],
    notices: string[] = [];

  try {
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => errors.push(error),
      uiContext: { setStatus() {}, notify: (text: string) => notices.push(text) } as any,
    });
    await session.prompt("/goal resume");

    for (
      let i = 0;
      i < 1000 && !errors.length && !notices.some((text) => text.startsWith("Goal confirmed:"));
      i++
    )
      await Bun.sleep(1);

    expect(errors).toEqual([]);
    expect(notices.some((text) => text.startsWith("Goal incomplete:"))).toBe(true);
    expect(notices.some((text) => text.startsWith("Goal confirmed:"))).toBe(true);
    expect(contexts.filter((context) => context.model === "working")).toHaveLength(2);
    expect(contexts.filter((context) => context.model === "reviewer")).toHaveLength(2);
  } finally {
    await session.abort();
    session.dispose();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
});

test("an incomplete goal renews critical context even if the model only reports a budget impasse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-auto-renewal-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = directory;

  const { session, contexts } = await fixture(directory, { pressure: 60000 });
  const errors: unknown[] = [],
    notices: string[] = [];

  session.sessionManager.appendMessage({
    role: "assistant",
    api: "fixture",
    provider: "fixture",
    model: "working",
    timestamp: 0,
    content: [{ type: "text", text: "Prior implementation evidence ".repeat(6000) }],
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  try {
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => errors.push(error),
      uiContext: { setStatus() {}, notify: (text: string) => notices.push(text) } as any,
    });
    await session.prompt("/goal resume");

    for (
      let i = 0;
      i < 1000 && !errors.length && !notices.some((text) => text.startsWith("Goal confirmed:"));
      i++
    )
      await Bun.sleep(1);

    expect(errors).toEqual([]);

    const work = contexts.filter((entry) => entry.model === "working");

    expect(work).toHaveLength(2);
    expect(JSON.stringify(work[1].messages).length).toBeLessThan(16000);
    expect(JSON.stringify(work[1].messages)).toContain(
      "Missing work identified by the goal reviewer",
    );
    expect(
      session.sessionManager
        .getBranch()
        .filter(
          (entry: any) =>
            entry.customType === "context-memory-rotation-state" && entry.data?.automatic,
        ),
    ).toHaveLength(1);
    expect(notices.some((text) => text.startsWith("Goal confirmed:"))).toBe(true);
  } finally {
    await session.abort();
    session.dispose();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(directory, { recursive: true, force: true });
  }
});
