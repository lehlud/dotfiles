import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  OPERATOR_INPUT_ENTRY,
  type OperatorInputKind,
} from "../shared/contracts/operator-input.ts";
import { operatorPromptRecords, promptDigest } from "../shared/review/prompts.ts";
import { sessionServices } from "../shared/session/services.ts";

type PendingInput = { promptId: string; kind: OperatorInputKind; afterId?: string };

/** Record delivery mode, not semantic importance; queued messages bind only after persistence. */
export function registerOperatorInputs(pi: ExtensionAPI) {
  let pending: PendingInput[] = [];
  let forwarded: { promptId: string; kind: OperatorInputKind } | undefined;

  const reset = () => {
    pending = [];
    forwarded = undefined;
  };

  const bind = (_event: unknown, ctx: ExtensionContext) => {
    reset();

    const services = sessionServices(ctx);

    services.flushOperatorInputs = () => flush(ctx);
    services.operatorInputKind = (text) =>
      pending.findLast((item) => item.promptId === promptDigest(text))?.kind;
    services.forwardOperatorInput = (text, kind) => {
      forwarded = { promptId: promptDigest(text), kind };
    };

  };

  pi.on("session_start", bind);
  pi.on("session_tree", bind);
  pi.on("session_shutdown", reset);
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") {
      return;
    }

    const promptId = promptDigest(event.text);
    let kind: OperatorInputKind = "task";

    if (forwarded?.promptId === promptId) {
      kind = forwarded.kind;
    } else if (
      event.streamingBehavior === "steer" ||
      (event.streamingBehavior !== "followUp" && !ctx.isIdle())
    ) {
      kind = "steering";
    }

    forwarded = undefined;
    pending.push({ promptId, kind, afterId: ctx.sessionManager.getBranch().at(-1)?.id });

    if (pending.length > 128) {
      pending.shift();
    }

  });

  const flush = (ctx: ExtensionContext) => {
    if (!pending.length) {
      return;
    }

    const entries = ctx.sessionManager.getBranch();
    const known = operatorPromptRecords(entries);
    let taskEntryId: string | undefined;

    for (const [index, entry] of entries.entries()) {
      if (entry.type !== "message" || entry.message.role !== "user" || !entry.id) {
        continue;
      }

      const prompt = known.find((item) => item.entryId === entry.id);

      if (prompt?.kind === "task") {
        taskEntryId = entry.id;
      }

      if (!prompt || prompt.kind !== "unknown") {
        continue;
      }

      const found = pending.findIndex((item) => {
        const after = entries.findIndex((previous) => previous.id === item.afterId);

        return (
          item.promptId === promptDigest(prompt.text) &&
          (!item.afterId || (after >= 0 && after < index))
        );
      });

      if (found < 0) {
        continue;
      }

      const input = pending.splice(found, 1)[0];

      if (input.kind === "task") {
        taskEntryId = entry.id;
      }

      pi.appendEntry(OPERATOR_INPUT_ENTRY, {
        messageId: entry.id,
        promptId: input.promptId,
        kind: input.kind,
        taskEntryId: sessionServices(ctx).operatorGoal?.() ? undefined : taskEntryId,
      });
    }

  };

}

