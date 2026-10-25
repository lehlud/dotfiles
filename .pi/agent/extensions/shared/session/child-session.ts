import type { AgentSession, InputEvent } from "@earendil-works/pi-coding-agent";
import type { OperatorInputKind } from "../contracts/operator-input.ts";
import { sessionServices } from "./services.ts";

type ChildEvent = Extract<
  Parameters<Parameters<AgentSession["subscribe"]>[0]>[0],
  {
    type:
      | "agent_start"
      | "agent_settled"
      | "message_update"
      | "message_end"
      | "tool_execution_start"
      | "tool_execution_update"
      | "tool_execution_end";
  }
>;

export class ChildSession {
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
    observe: (event: ChildEvent) => void = () => {},
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

          if (event.type === "agent_settled")
            queueMicrotask(() => {
              if (!this.stopped && !this.busy) this.settled();
            });
      }
    });
  }

  get busy() {
    return (
      this.pending > 0 ||
      this.runs.size > 0 ||
      this.session.isStreaming ||
      !!sessionServices({ sessionManager: this.session.sessionManager }).jobs?.busy ||
      (sessionServices({ sessionManager: this.session.sessionManager }).subagentsBusy?.() ?? false)
    );
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

  protected append(type: string, data: Record<string, unknown>) {
    if (!this.stopped) this.session.sessionManager.appendCustomEntry(type, data);
  }

  async close() {
    if (this.stopped) return;

    this.stopped = true;

    const descendants = Promise.resolve(
      sessionServices({ sessionManager: this.session.sessionManager }).stopSubagents?.(),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

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
      const descendantFailure = await descendants;

      await sessionServices({ sessionManager: this.session.sessionManager }).cleanup?.();

      if (descendantFailure) throw descendantFailure;
    } finally {
      this.session.dispose();
    }
  }
}
