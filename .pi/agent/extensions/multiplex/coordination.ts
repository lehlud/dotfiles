import { randomUUID } from "node:crypto";

export type Assignment = { name: string; task: string; resources: string[]; waiting?: boolean };

type Plan = { id: string; assignments: Assignment[]; accepted: Set<string> };

const normalized = (text: string) =>
  text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const resource = (text: string) =>
  normalized(text).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

/** A unanimous work split, not an approval grant or a privileged coordinator. */
export class Coordination {
  private plan?: Plan;
  private active = 0;
  private closed = false;
  constructor(
    private names: readonly string[],
    private changed: (ready: boolean) => void = () => {},
  ) {}

  get ready() {
    return !!this.plan && this.plan.accepted.size === this.names.length && !this.closed;
  }

  propose(from: string, assignments: Assignment[]) {
    this.member(from);

    if (this.active)
      throw new Error(
        "Wait for current external actions to finish before changing the work split.",
      );

    if (this.plan && !this.ready)
      throw new Error(
        "A work split is awaiting acceptance; inspect it, accept it or withdraw it before proposing another.",
      );

    if (
      assignments.length !== this.names.length ||
      new Set(assignments.map((item) => item.name)).size !== this.names.length ||
      assignments.some((item) => !this.names.includes(item.name))
    )
      throw new Error("Assign every member exactly once.");

    const tasks = new Set<string>(),
      scopes: { owner: string; path: string }[] = [];

    for (const item of assignments) {
      const task = normalized(item.task);

      if (!task || tasks.has(task))
        throw new Error(
          "Each member needs a distinct, nonempty task; use waiting:true when useful independent work is unavailable.",
        );

      tasks.add(task);

      if (!item.waiting && !item.resources.length)
        throw new Error(
          "Working assignments require explicit resource ownership, including discovery or validation work.",
        );

      for (const entry of item.resources) {
        const path = resource(entry);

        if (!path || path.split("/").some((part) => part === "." || part === ".."))
          throw new Error("Use explicit resources without traversal or root-wide claims.");

        if (scopes.some((old) => old.owner !== item.name && overlaps(old.path, path)))
          throw new Error(
            "Resource ownership overlaps; assign discovery and each shared check to one member.",
          );

        scopes.push({ owner: item.name, path });
      }
    }

    this.plan = {
      id: randomUUID(),
      assignments: structuredClone(assignments),
      accepted: new Set([from]),
    };
    this.changed(this.ready);

    return this.snapshot();
  }

  accept(from: string, id: string) {
    this.member(from);

    if (!this.plan || this.plan.id !== id)
      throw new Error("Work split is stale; inspect the current coordination state.");

    if (!this.plan.accepted.has(from)) {
      this.plan.accepted.add(from);

      if (this.ready) this.changed(true);
    }

    return this.snapshot();
  }

  withdraw(from: string, id: string) {
    this.member(from);

    if (this.active)
      throw new Error(
        "Wait for current external actions to finish before withdrawing the work split.",
      );

    if (!this.plan || this.plan.id !== id) throw new Error("Work split is stale.");

    this.plan = undefined;
    this.changed(false);

    return this.snapshot();
  }

  acquire(from: string) {
    this.member(from);

    const id = this.plan?.id;
    const assertCurrent = () => {
      this.member(from);

      if (!this.ready || this.plan?.id !== id)
        throw new Error(
          "Multiplex coordination: agree one work split with every member before external actions. Use mailbox plan/accept; assign shared discovery once.",
        );

      if (this.plan!.assignments.find((item) => item.name === from)?.waiting)
        throw new Error(
          "Multiplex coordination: your assignment is waiting. Let its owner work; agree an updated split before starting external actions.",
        );
    };

    assertCurrent();
    this.active++;

    let released = false;

    return {
      scope: {
        planId: id,
        ...structuredClone(this.plan!.assignments.find((item) => item.name === from)!),
      },
      assertCurrent,
      release: () => {
        if (!released) {
          released = true;
          this.active--;
        }
      },
    };
  }

  snapshot() {
    return this.plan
      ? {
          id: this.plan.id,
          ready: this.ready,
          assignments: structuredClone(this.plan.assignments),
          accepted: [...this.plan.accepted],
          pending: this.names.filter((name) => !this.plan!.accepted.has(name)),
        }
      : { ready: false, assignments: [] as Assignment[], accepted: [], pending: [...this.names] };
  }

  describe() {
    const plan = this.snapshot();

    return `Coordination: ${plan.ready ? "ready" : "planning"}\nPlan ID: ${"id" in plan ? plan.id : "none"}\n${plan.assignments.map((item) => `${item.name}: ${item.task} | resources: ${item.resources.join(", ")} | ${item.waiting ? "waiting" : "work"}`).join("\n")}\nPending acceptance: ${plan.pending.join(", ") || "none"}`;
  }

  close() {
    this.closed = true;
  }

  private member(name: string) {
    if (this.closed || !this.names.includes(name))
      throw new Error("Multiplex coordination is inactive or member is unknown.");
  }
}
