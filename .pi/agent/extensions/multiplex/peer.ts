import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
  type InputEvent,
} from "@earendil-works/pi-coding-agent";
import autoApproval from "../auto-approval/index.ts";
import publicWriting from "../public-writing/index.ts";
import codeQuality from "../code-quality/index.ts";
import { registerQuestionTools, bindPeerQuestions } from "../conversations/questions/tools.ts";
import { registerGoalTool } from "../conversations/goal-tool.ts";
import { registerProgress } from "../conversations/progress.ts";
import { registerSteering } from "../conversations/steering.ts";
import { registerOperatorInputs } from "../conversations/operator-input.ts";
import type { OperatorInputKind } from "../shared/contracts/operator-input.ts";
import { installProviderStreams } from "../shared/providers/stream.ts";
import { registerFastRequests } from "../shared/providers/fast.ts";
import { sessionServices } from "../shared/session/services.ts";
import { registerEndpoint, type Endpoint } from "./endpoint.ts";
import { letterMessage, PEER_RESULT, type Letter } from "./mailboxes.ts";
import type { ActivityEvent } from "./activity.ts";

/** All peers use the same trusted providers; credentials never enter model context. */
export async function peerRuntime(ctx: ExtensionContext) {
  installProviderStreams(ctx.modelRegistry);

  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  for (const id of new Set(ctx.modelRegistry.getAll().map((model) => model.provider))) {
    const provider = ctx.modelRegistry.getProvider(id);

    if (provider) runtime.registerNativeProvider(provider);
  }

  return runtime;
}

export class Peer {
  private admission: Promise<void> = Promise.resolve();
  private runs = new Set<Promise<void>>();
  private stopped = false;
  private pending = 0;
  private unsubscribe: () => void;
  private waiting = new Set<() => void>();
  constructor(
    readonly session: AgentSession,
    private report: (error: string) => void,
    private settled: () => void,
    observe: (event: ActivityEvent) => void = () => {},
  ) {
    this.unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
        case "agent_settled":
        case "message_update":
        case "message_end":
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end":
          observe(event);
      }
    });
  }

  get busy() {
    return this.pending > 0 || this.runs.size > 0 || this.session.isStreaming;
  }

  canDeliver() {
    return !this.stopped && this.pending < 256;
  }

  private async waitForCompaction() {
    while (!this.stopped && this.session.isCompacting)
      await new Promise<void>((resolve) => {
        const done = () => {
          unsubscribe();
          this.waiting.delete(done);
          resolve();
        };

        const unsubscribe = this.session.subscribe((event) => {
          if (event.type === "compaction_end") done();
        });

        this.waiting.add(done);

        if (this.stopped || !this.session.isCompacting) done();
      });
  }

  private enqueue(start: () => Promise<void>, operator = false) {
    if (this.stopped) return;

    if (!operator && this.pending >= 256) throw new Error("Peer input queue is full");

    this.pending++;
    this.admission = this.admission
      .then(async () => {
        // prompt() rejects before input hooks during compaction. Retain the input
        // until admissible; never retry an already accepted model/tool request.
        await this.waitForCompaction();

        if (this.stopped) return;

        let ready!: () => void;
        const started = new Promise<void>((resolve) => {
          ready = resolve;
        });

        const unsubscribe = this.session.subscribe((event) => {
          if (event.type === "agent_start") ready();
        });

        const run = start().catch(() => {
          if (!this.stopped)
            this.report("Peer request failed; the task will not be automatically repeated.");
        });

        this.runs.add(run);
        void run.finally(() => {
          this.runs.delete(run);

          if (!this.stopped && !this.busy) this.settled();
        });

        try {
          await Promise.race([started, run]);
        } finally {
          unsubscribe();
        }
      })

      .catch(() => this.report("Peer delivery failed."))
      .finally(() => {
        this.pending--;

        if (!this.stopped && !this.busy) this.settled();
      });
  }

  prompt(
    event: Pick<InputEvent, "text" | "images" | "streamingBehavior">,
    kind?: OperatorInputKind,
  ) {
    const copy = structuredClone(event);

    this.enqueue(() => {
      if (kind)
        sessionServices({ sessionManager: this.session.sessionManager }).forwardOperatorInput?.(
          copy.text,
          kind,
        );

      return this.session.prompt(copy.text, {
        images: copy.images,
        expandPromptTemplates: false,
        source: "interactive",
        streamingBehavior: copy.streamingBehavior ?? "steer",
      });
    }, true);
  }

  message(message: Parameters<AgentSession["sendCustomMessage"]>[0], triggerTurn = true) {
    const copy = structuredClone(message);

    this.enqueue(() => this.session.sendCustomMessage(copy, { triggerTurn, deliverAs: "steer" }));
  }

  deliver(letter: Letter) {
    this.message(letterMessage(letter), letter.wake === true);
  }

  audit(data: Record<string, unknown>) {
    if (!this.stopped) this.session.sessionManager.appendCustomEntry("auto-approval-review", data);
  }

  result(data: Record<string, unknown>) {
    if (!this.stopped) this.session.sessionManager.appendCustomEntry(PEER_RESULT, data);
  }

  async close() {
    if (this.stopped) return;

    this.stopped = true;
    this.unsubscribe();

    for (const done of [...this.waiting]) done();

    this.session.clearQueue();
    await this.session.abort();
    await this.admission;
    this.session.clearQueue();
    // An ongoing authentication/start hook may enter the SDK loop only after
    // the first abort. Cancel that late start as well.
    await this.session.abort();
    await Promise.allSettled([...this.runs]);

    try {
      await sessionServices({ sessionManager: this.session.sessionManager }).cleanup?.();
    } finally {
      this.session.dispose();
    }
  }
}

export async function createPeer(
  ctx: ExtensionContext,
  endpoint: Endpoint,
  runtime: ModelRuntime,
  report: (error: string) => void,
  answer: (text: string) => void,
  settled: () => void,
  branch = ctx.sessionManager.getBranch(),
  observe?: (event: ActivityEvent) => void,
) {
  const entries = structuredClone(branch);
  const manager = SessionManager.inMemory(ctx.cwd, undefined, [
    {
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: ctx.cwd,
    },
    ...entries,
  ]);
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    systemPrompt: ctx.getSystemPrompt(),
    extensionFactories: [
      autoApproval,
      publicWriting,
      codeQuality,
      (pi) => {
        registerOperatorInputs(pi);
        registerGoalTool(pi);
        registerQuestionTools(pi);
        registerFastRequests(pi);
        pi.on("session_start", (_event, child) => {
          sessionServices(child).operatorGoal = endpoint.operatorGoal;

          bindPeerQuestions(ctx, child, endpoint.name);
          sessionServices(child).setAgentGoal = (text, signal) => {
            const set = sessionServices(ctx).setAgentGoal;

            if (!set) {
              throw new Error("Session goal controller unavailable");
            }

            return set(text, signal);
          };
          sessionServices(child).fastMode = () => sessionServices(ctx).fastMode?.() ?? false;
        });

        registerSteering(pi, endpoint.operatorGoal);
        registerProgress(pi, (_child, reason) => report(reason));
        registerEndpoint(pi, () => endpoint);
        pi.on("turn_end", (event) => {
          if (event.outcome === "error") report("Peer model run failed; its result is incomplete.");
        });

        pi.on("agent_settled", (_event, child) => {
          const last = child.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
            .at(-1);

          if (
            last?.type === "message" &&
            last.message.role === "assistant" &&
            last.message.stopReason === "stop"
          ) {
            const text = Array.isArray(last.message.content)
              ? last.message.content
                  .filter((block) => block.type === "text")
                  .map((block) => (block.type === "text" ? block.text : ""))
                  .join("\n")
              : "";

            if (text) answer(text);
          }
        });
      },
    ],
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    modelRuntime: runtime,
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel ?? "medium",
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    tools: ["approved_action", "mailbox", "set_goal", "ask_user", "user_questions"],
  });

  try {
    await session.bindExtensions({
      mode: "json",
      onError: () => report("Peer extension reported an error."),
      uiContext: {
        setStatus() {},

        setWidget() {},

        notify: (_text: string, kind?: string) => {
          if (kind === "error") report("Peer sandbox or configuration unavailable.");
        },
      } as any,
    });

    return new Peer(session, report, settled, observe);
  } catch (error) {
    await sessionServices({ sessionManager: manager }).cleanup?.();
    session.dispose();

    throw error;
  }
}
