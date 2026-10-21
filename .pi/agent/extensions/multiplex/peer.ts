import { ChildSession } from "../shared/session/child-session.ts";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import autoApproval from "../auto-approval/index.ts";
import publicWriting from "../public-writing/index.ts";
import codeQuality from "../code-quality/index.ts";
import subagents from "../subagents/index.ts";
import contextManagement from "../context-management/index.ts";
import { registerQuestionTools, bindPeerQuestions } from "../conversations/questions/tools.ts";
import { registerGoalTool } from "../conversations/goal-tool.ts";
import { registerProgress } from "../conversations/progress.ts";
import { registerSteering } from "../conversations/steering.ts";
import { registerOperatorInputs } from "../conversations/operator-input.ts";

export { childRuntime as peerRuntime } from "../shared/providers/child-runtime.ts";

import { registerFastRequests } from "../shared/providers/fast.ts";
import { sessionServices } from "../shared/session/services.ts";
import { registerGoalContext } from "../shared/session/goal-context.ts";
import { registerEndpoint, type Endpoint } from "./endpoint.ts";
import { letterMessage, PEER_RESULT, type Letter } from "./mailboxes.ts";
import type { ActivityEvent } from "./activity.ts";

export class Peer extends ChildSession {
  deliver(letter: Letter) {
    this.message(letterMessage(letter), letter.wake === true);
  }
  audit(data: Record<string, unknown>) {
    this.append("auto-approval-review", data);
  }
  result(data: Record<string, unknown>) {
    this.append(PEER_RESULT, data);
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
      subagents,
      contextManagement,
      (pi) => {
        registerOperatorInputs(pi);
        registerGoalTool(pi);
        registerGoalContext(pi);
        registerQuestionTools(pi);
        registerFastRequests(pi);
        pi.on("session_start", (_event, child) => {
          sessionServices(child).parentCacheLineage = () => sessionServices(ctx).cacheLineage?.();
          sessionServices(child).publishSubagentActivity = (record) =>
            sessionServices(ctx).publishSubagentActivity?.({
              ...record,
              title: `${endpoint.name} / ${record.title}`,
            });
          sessionServices(child).operatorGoal = endpoint.operatorGoal;
          sessionServices(child).goalInstruction = () => sessionServices(ctx).goalInstruction?.();

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
    tools: [
      "approved_action",
      "mailbox",
      "set_goal",
      "ask_user",
      "user_questions",
      "subagent",
      "history",
      "notes",
      "new_context",
    ],
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
