import { ChildSession } from "../shared/session/child-session.ts";
import { randomUUID } from "node:crypto";
import {
  type ModelRuntime,
  SessionManager,
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

import { createHeadlessSession } from "../shared/session/headless-session.ts";
import { registerParentContext } from "../shared/session/inherit.ts";
import { textContent } from "../shared/review/protocol.ts";
import { sessionServices } from "../shared/session/services.ts";
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
  const session = await createHeadlessSession(ctx, {
    manager,
    runtime,
    extensions: [
      autoApproval,
      publicWriting,
      codeQuality,
      subagents,
      contextManagement,
      (pi) => {
        registerOperatorInputs(pi);
        registerGoalTool(pi);
        registerQuestionTools(pi);
        registerParentContext(pi, ctx);
        pi.on("session_start", (_event, child) => {
          sessionServices(child).publishSubagentActivity = (record) =>
            sessionServices(ctx).publishSubagentActivity?.({
              ...record,
              title: `${endpoint.name} / ${record.title}`,
            });
          sessionServices(child).operatorGoal = endpoint.operatorGoal;

          bindPeerQuestions(ctx, child, endpoint.name);
          sessionServices(child).setAgentGoal = (text, signal, update) => {
            const set = sessionServices(ctx).setAgentGoal;

            if (!set) {
              throw new Error("Session goal controller unavailable");
            }

            return set(text, signal, update);
          };
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
            const text = textContent(last.message.content);

            if (text) answer(text);
          }
        });
      },
    ],
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
    errors: {
      report,
      extension: "Peer extension reported an error.",
      sandbox: "Peer sandbox or configuration unavailable.",
    },
  });

  return new Peer(session, report, settled, observe);
}
