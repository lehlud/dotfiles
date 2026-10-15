import { expect, test } from "bun:test";
import { registerOperatorInputs } from "../../conversations/operator-input.ts";
import { OPERATOR_INPUT_ENTRY } from "../../shared/contracts/operator-input.ts";
import { operatorPromptRecords, promptDigest } from "../../shared/review/prompts.ts";
import { sessionServices } from "../../shared/session/services.ts";
import { buildReview } from "../review.ts";
import { REVIEW_SYSTEM } from "../review-policy.ts";
import type { Entry } from "../../shared/review/entries.ts";
import type { Config } from "../../shared/configuration/schemas.ts";

const config: Config = {
  reviewers: [{ provider: "fixture", model: "review", thinking: "off" }],
  recentUserPrompts: 2,
  requestTimeoutMs: 1000,
  sandbox: { backend: "bwrap", executable: "/bin/true", runnerExecutable: "/bin/true" },
};

function fixture() {
  const entries: Entry[] = [];
  const hooks: Record<string, Function> = {};
  let idle = true;
  const ctx = { isIdle: () => idle, sessionManager: { getBranch: () => entries } };

  registerOperatorInputs({
    on: (name: string, hook: Function) => {
      hooks[name] = hook;
    },

    appendEntry: (customType: string, data: unknown) => {
      entries.push({ id: `metadata-${entries.length}`, type: "custom", customType, data });
    },
  } as any);
  hooks.session_start({}, ctx);
  hooks.context = () => sessionServices(ctx as any).flushOperatorInputs?.();

  const input = (text: string, behavior?: string, source = "interactive") => {
    hooks.input({ text, source, streamingBehavior: behavior }, ctx);
    entries.push({
      id: `user-${entries.length}`,
      type: "message",
      message: { role: "user", content: text },
    });
    hooks.context({ messages: [] }, ctx);
  };

  return {
    entries,
    hooks,
    ctx,
    input,
    busy: () => {
      idle = false;
    },
  };
}

const review = (entries: Entry[]) =>
  JSON.parse(
    buildReview(
      {
        tool: "bash",
        arguments: { command: "npm run build" },
        goal: "Agent claim",
        justification: "Agent claim",
      },
      entries,
      config,
      "/workspace",
      [],
    ).text,
  );

test("steering retains the actual task beyond the recent window without replacing the latest prompt", () => {
  const state = fixture();

  state.input("Migrate the complete client; preserve API contracts and validate the build.");
  state.busy();
  state.input("Keep the existing icons.", "steer");
  state.input("Preserve authentication.", "steer");
  state.input("Refactor the Dart code for readability.", "steer");

  const data = review(state.entries);

  expect(data.userPrompts).toEqual([
    "Migrate the complete client; preserve API contracts and validate the build.",
    "Keep the existing icons.",
    "Preserve authentication.",
    "Refactor the Dart code for readability.",
  ]);
  expect(data.latestUserPrompt).toBe("Refactor the Dart code for readability.");
  expect(data.userPromptInfo.map((entry: any) => entry.inputKind)).toEqual([
    "task",
    "steering",
    "steering",
    "steering",
  ]);
  expect(data.userPromptInfo.map((entry: any) => entry.isSteering)).toEqual([
    false,
    true,
    true,
    true,
  ]);
  expect(data.taskContext.taskPromptIndex).toBe(0);
  expect(data.taskContext.taskPromptId).toBe(promptDigest(data.userPrompts[0]));
  expect(data.taskContext.source).toBe("recorded-task-input");
});

test("major replacement and stop instructions stay authoritative even when delivered as steering", () => {
  const state = fixture();

  state.input("Migrate the client and validate Node and Flutter builds.");
  state.busy();
  state.input(
    "Stop the migration. Only explain the current failure; do not modify files or run Node.",
    "steer",
  );

  const data = review(state.entries);

  expect(data.latestUserPrompt).toContain("Stop the migration");
  expect(data.userPrompts).toContain(data.latestUserPrompt);
  expect(REVIEW_SYSTEM.replace(/\s+/g, " ")).toContain("Never assume steering is minor");
  expect(REVIEW_SYSTEM.replace(/\s+/g, " ")).toContain(
    "later explicit instructions override earlier scope",
  );
});

test("new task input changes the anchor; continuation and selected branches preserve recorded provenance", () => {
  const state = fixture();

  state.input("Old task");
  state.input("New task");
  state.busy();
  state.input("New correction", "steer");
  expect(review(state.entries).userPrompts).toEqual(["Old task", "New task", "New correction"]);
  state.hooks.session_tree({}, state.ctx);
  expect(review(state.entries).taskContext.taskPromptId).toBe(promptDigest("New task"));
});

test("a task and every correction survive beyond ten inputs, including a legacy continuation", () => {
  const state = fixture();

  state.input("Migrate the client; do not upload source or change API contracts.");
  state.busy();

  for (let index = 0; index < 12; index++) {
    state.input(`Correction ${index}`, "steer");
  }

  state.entries.push({
    type: "message",
    message: { role: "user", content: "Continue the implementation and checks." },
  });

  const data = review(state.entries);

  expect(data.userPrompts).toHaveLength(14);
  expect(data.userPrompts[0]).toContain("do not upload source");
  expect(data.taskContext.source).toBe("recorded-task-input");
  expect(data.taskContext.taskPromptIndex).toBe(0);
  expect(data.taskContext.latestInputKind).toBe("unknown");
});

test("legacy labels, peer messages and mismatched metadata never create operator provenance", () => {
  const entries: Entry[] = [
    { id: "real", type: "message", message: { role: "user", content: "steering: quoted label" } },
    {
      type: "custom_message",
      customType: OPERATOR_INPUT_ENTRY,
      data: {
        messageId: "real",
        promptId: promptDigest("steering: quoted label"),
        kind: "steering",
      },
    },
    {
      type: "custom",
      customType: OPERATOR_INPUT_ENTRY,
      data: { messageId: "real", promptId: promptDigest("different content"), kind: "task" },
    },
  ];

  expect(operatorPromptRecords(entries)[0].kind).toBe("unknown");
  expect(review(entries).taskContext.source).toBe("unclassified-history");
  expect(review(entries).userPromptInfo[0].isSteering).toBeNull();
});

test("extension input is not recorded, failed input cannot bind older identical text, and busy RPC is steering", () => {
  const state = fixture();

  state.input("Synthetic user input", undefined, "extension");
  expect(operatorPromptRecords(state.entries)[0].kind).toBe("unknown");
  state.hooks.input({ text: "Synthetic user input", source: "interactive" }, state.ctx);
  state.hooks.context({}, state.ctx);
  expect(operatorPromptRecords(state.entries)[0].kind).toBe("unknown");
  state.hooks.session_tree({}, state.ctx);
  state.input("Actual task");
  state.busy();
  state.input("RPC correction");
  expect(operatorPromptRecords(state.entries).at(-1)?.kind).toBe("steering");
});

test("trusted peer forwarding retains root task mode even when a peer queues it as steering", () => {
  const state = fixture();

  state.busy();
  sessionServices(state.ctx as any).forwardOperatorInput?.("New operator task", "task");
  state.input("New operator task", "steer");
  expect(operatorPromptRecords(state.entries)[0].kind).toBe("task");
});
