import { availableQuestionTools, QUESTION_TOOLS } from "../shared/contracts/questions.ts";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { assertSandboxReady } from "../shared/configuration/load.ts";
import { loadSessionConfig } from "../shared/session/config.ts";
import { sessionServices } from "../shared/session/services.ts";
import { reviewerLabel } from "../shared/review/client.ts";
import { detectWorkspace } from "./isolation.ts";
import { createApprovalRenderers } from "./renderers.ts";
import { definitions, parameters, TOOL_NAME } from "./tool-catalog.ts";
import { availableGoalTools, GOAL_TOOL } from "../shared/contracts/goal.ts";
import { ACTION_DESCRIPTION, ACTION_POLICY, LOCK_MESSAGE } from "./instructions.ts";
import { ActionSession } from "./action-session.ts";
import { actionHandler } from "./action-handler.ts";
import { availableSubagentTools } from "../shared/contracts/subagents.ts";
import { availableContextTools } from "../shared/contracts/context.ts";

const configPath = join(getAgentDir(), "auto-approval.json");
const localConfigPath = join(getAgentDir(), "auto-approval.device.json");

export default function autoApproval(pi: ExtensionAPI) {
  const session = new ActionSession();

  pi.on("session_shutdown", () => session.cleanup());

  function lock(ctx: ExtensionContext) {
    pi.setActiveTools([
      TOOL_NAME,
      ...availableGoalTools(pi),
      ...availableQuestionTools(pi),
      ...availableSubagentTools(pi),
      ...availableContextTools(pi),
      ...(sessionServices(ctx).mailbox?.active() ? ["mailbox"] : []),
    ]);
    // Clear a widget left by an older version after /reload.
    ctx.ui.setWidget("auto-approval", undefined);
    ctx.ui.setStatus("auto-approval", undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionServices(ctx).cleanup = () => session.cleanup();
    lock(ctx);

    try {
      const config = await loadSessionConfig(ctx);

      await assertSandboxReady(config);

      if (!config.reviewers.length) {
        ctx.ui.notify(
          "Auto-Approval needs a reviewer. Use /reviewer set <provider/model> <thinking>.",
          "warning",
        );
      }
    } catch (error) {
      ctx.ui.setStatus("auto-approval", "approval: LOCKED");
      ctx.ui.notify(`Auto-Approval LOCKED: ${String(error)}`, "error");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    lock(ctx);

    return {
      message: {
        customType: "auto-approval-policy",
        display: false,
        content: ACTION_POLICY,
      },
    };
  });

  pi.on("tool_call", (event) => {
    // Internal mailbox, goal and question metadata grant no external-action permissions.
    if (
      event.toolName === "mailbox" ||
      event.toolName === GOAL_TOOL ||
      availableSubagentTools(pi).includes(event.toolName) ||
      availableContextTools(pi).includes(event.toolName) ||
      QUESTION_TOOLS.some((name) => name === event.toolName)
    )
      return;

    if (event.toolName !== TOOL_NAME || event.parentToolCallId)
      return { block: true, reason: LOCK_MESSAGE };
  });

  pi.on("user_bash", async () => ({
    result: {
      output:
        "Auto-Approval: !/!! and direct user/RPC shell execution are blocked. Ask the agent to submit a justified approved_action instead.",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  }));
  pi.registerCommand("auto-approval", {
    description: "Show mandatory approval configuration; use /reviewer to select approval models",
    handler: async (_args, ctx) => {
      try {
        const config = await loadSessionConfig(ctx);

        await assertSandboxReady(config);
        ctx.ui.notify(
          `Auto-Approval ON\nActive reviewers (priority order):\n${config.reviewers.map((item, i) => `${i + 1}. ${reviewerLabel(item)}`).join("\n") || "None. Use /reviewer set <provider/model> <thinking>."}\nSandbox: ${config.sandbox.backend ?? "docker"}\nWorkspace: ${(await detectWorkspace(ctx.cwd)).path} (automatic; home-level Git roots ignored)\nCurrent directory: ${ctx.cwd}\nConfig: ${configPath}\nDevice paths/views/credential profiles (optional): ${localConfigPath}\nUse /reviewer for persistent model choices. Changes apply at the next turn; in-flight reviews keep their selection. No bypass/off command.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Auto-Approval LOCKED: ${String(error)}\nConfig: ${configPath}\nDevice paths/views/credential profiles (optional): ${localConfigPath}`,
          "error",
        );
      }
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Reviewed action",
    exposure: "model-only",
    // The action queue serializes external operations without delaying internal peer messages.
    executionMode: "parallel",
    description: ACTION_DESCRIPTION,
    promptSnippet: "Request independent approval and execution of one operation",
    parameters,
    ...createApprovalRenderers(definitions),
    execute: actionHandler(pi, session),
  });
}
