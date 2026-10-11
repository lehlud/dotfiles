type Unread = { name: string; sequence: number };

/** Event-driven goal recovery; no polling, repeated letters or authority grants. */
export class Quiescence {
  private goal?: string;
  private awakened = new Map<string, number>();
  private checkpoint?: string;
  settle(
    goal: string | undefined,
    revision: number,
    unread: readonly Unread[],
    wake: (name: string) => void,
    check: () => void,
  ) {
    if (!goal) return;
    if (this.goal !== goal) {
      this.goal = goal;
      this.awakened.clear();
      this.checkpoint = undefined;
    }
    // Read dependency deliveries before asking for a verdict on older evidence.
    if (unread.length) {
      for (const { name, sequence } of unread) {
        if (sequence <= (this.awakened.get(name) ?? 0)) continue;
        this.awakened.set(name, sequence);
        wake(name);
      }
      return;
    }
    const key = `${goal}:${revision}`;
    if (this.checkpoint === key) return;
    this.checkpoint = key;
    check();
  }
}
