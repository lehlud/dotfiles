import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { providerWait } from "./request-deadline.ts";
import { providerErrorMessage, providerErrorStatus, retryableProvider401 } from "./error-code.ts";

export const PROVIDER_RETRY_DELAYS_MS = [
  15000, 15000, 60000, 150000, 300000, 300000, 300000, 900000, 900000, 900000,
] as const;
export const PROVIDER_PERSISTENT_DELAY_MS = 1800000;

export function providerRetryDelay(retry: number): number {
  return PROVIDER_RETRY_DELAYS_MS[retry - 1] ?? PROVIDER_PERSISTENT_DELAY_MS;
}

type Pair = { provider: string; id: string };

type Clock = { now(): number; wait(ms: number, signal?: AbortSignal): Promise<void> };

type State = { retry: number; until: number; owner?: symbol; changed: Promise<void>; wake(): void };

export type AvailabilityNotice = {
  provider: string;
  model: string;
  retry: number;
  delayMs: number;
  waitingForRecovery?: boolean;
};

export function recoveryLabel(event: AvailabilityNotice) {
  return `${event.provider}/${event.model} · ${event.waitingForRecovery ? "waiting for recovery" : `retry ${event.retry} in ${event.delayMs / 1000}s`}`;
}

export class RecoveryAuditError extends Error {
  readonly code = "PI_RECOVERY_AUDIT";

  constructor() {
    super("Provider recovery audit failed; no fallback, nothing executed");
  }
}

export function isRecoveryAuditError(error: unknown): error is RecoveryAuditError {
  return error instanceof Error && error.message === new RecoveryAuditError().message;
}

/** Policy refusals are final, including provider-side cybersecurity checks. */
export function providerRefusal(error: unknown): boolean {
  const message = providerErrorMessage(error);

  return /refusal|(?:reviewer|model|policy|request).*(?:refus|block)|content.filter|safety|content.*flagged.*cybersecurity|cybersecurity.*(?:risk|check.*fail)/i.test(
    message,
  );
}

export function transientProviderError(error: unknown): boolean {
  const message = providerErrorMessage(error);

  if (
    providerRefusal(message) ||
    /context.*(?:length|window|overflow)|invalid.*schema|schema.*invalid|unsupported.*param|quota|billing|out of budget/i.test(
      message,
    )
  )
    return false;

  if (retryableProvider401(error)) return true;

  if ([401, 403].includes(providerErrorStatus(error) ?? 0)) return false;

  if (/\b401\b|\b403\b|api.?key|authentication/i.test(message)) return false;

  return (
    /\b5\d\d\b|ECONN|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(message) ||
    isRetryableAssistantError({ stopReason: "error", errorMessage: message } as any)
  );
}

function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const until = Date.now() + ms;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Operation aborted"));
    };
    const tick = () => {
      const remaining = until - Date.now();

      if (remaining <= 0) {
        cleanup();
        resolve();
      } else timer = setTimeout(tick, Math.min(remaining, 15000));
    };

    signal?.addEventListener("abort", abort, { once: true });
    tick();
  });
}

async function interruptible<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();

  if (!signal) return await work();

  let abort: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Operation aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();

        return work();
      }),

      cancelled,
    ]);
  } finally {
    signal.removeEventListener("abort", abort!);
  }
}

function wake(state: State) {
  state.wake();
  state.changed = new Promise<void>((resolve) => {
    state.wake = resolve;
  });
}

/** One recovery owner per provider/model pair; successful transport resets its schedule. */
export class ProviderAvailability {
  private readonly states = new Map<string, State>();
  private readonly clock: Clock;
  constructor(clock: Partial<Clock> = {}) {
    this.clock = { now: () => Date.now(), wait: abortableWait, ...clock };
  }

  /** Explicit operator continuation can advance one idle retry, never an active recovery. */
  requestProbe(pair: Pair): boolean {
    const state = this.states.get(JSON.stringify([pair.provider, pair.id]));

    if (!state || state.owner) return false;

    state.until = 0;
    wake(state);

    return true;
  }

  async run<T>(
    pair: Pair,
    work: () => Promise<T>,
    unavailable: (value: T) => boolean,
    signal?: AbortSignal,
    notice?: (event: AvailabilityNotice) => void,
  ): Promise<T> {
    const key = JSON.stringify([pair.provider, pair.id]);
    const owner = Symbol();

    try {
      while (true) {
        signal?.throwIfAborted();

        const state = this.states.get(key);

        if (state?.owner && state.owner !== owner) {
          this.notify(pair, state, notice, true);
          await providerWait(signal, () => interruptible(() => state.changed, signal));

          continue;
        }

        if (state) {
          state.owner = owner;

          const delay = Math.max(0, state.until - this.clock.now());

          this.notify(pair, state, notice);

          if (delay) await this.wait(state, delay, signal);

          signal?.throwIfAborted();

          if (this.states.get(key) !== state) continue;
        }

        try {
          const result = await interruptible(work, signal);

          signal?.throwIfAborted();

          if (!unavailable(result)) {
            this.recovered(key);

            return result;
          }
        } catch (error) {
          signal?.throwIfAborted();

          if (!transientProviderError(error)) {
            this.recovered(key);

            throw error;
          }
        }

        this.failed(key, owner);
      }
    } finally {
      const state = this.states.get(key);

      if (state?.owner === owner) {
        state.owner = undefined;
        wake(state);
      }
    }
  }

  private failed(key: string, owner: symbol) {
    let state = this.states.get(key);

    // Other healthy calls may already have been in flight when the outage began.
    // Their failures join the owner, rather than consuming extra retry levels.
    if (state?.owner && state.owner !== owner) return;

    if (!state) {
      let resolve!: () => void;
      const changed = new Promise<void>((done) => {
        resolve = done;
      });

      state = { retry: 0, until: 0, changed, wake: resolve };
      this.states.set(key, state);
    }

    state.owner = owner;
    state.retry++;
    state.until = this.clock.now() + providerRetryDelay(state.retry);
  }

  private recovered(key: string) {
    const state = this.states.get(key);

    this.states.delete(key);

    if (state) wake(state);
  }

  private notify(
    pair: Pair,
    state: State,
    notice?: (event: AvailabilityNotice) => void,
    waitingForRecovery = false,
  ) {
    try {
      notice?.({
        provider: pair.provider,
        model: pair.id,
        retry: state.retry,
        delayMs: Math.max(0, state.until - this.clock.now()),
        ...(waitingForRecovery ? { waitingForRecovery: true } : {}),
      });
    } catch {
      throw new RecoveryAuditError();
    }
  }

  private async wait(state: State, ms: number, signal?: AbortSignal) {
    const controller = new AbortController();
    const stop = () => controller.abort(signal?.reason);

    signal?.addEventListener("abort", stop, { once: true });

    if (signal?.aborted) stop();

    try {
      await providerWait(signal, () =>
        interruptible(
          () => Promise.race([this.clock.wait(ms, controller.signal), state.changed]),
          signal,
        ),
      );
    } finally {
      signal?.removeEventListener("abort", stop);
      controller.abort();
    }
  }
}

const sharedKey = Symbol.for("pi.auto-approval.provider-availability.v2");
const shared = globalThis as typeof globalThis & { [sharedKey]?: ProviderAvailability };
export const providerAvailability = (shared[sharedKey] ??= new ProviderAvailability());
