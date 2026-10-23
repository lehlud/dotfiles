import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { providerErrorMessage, providerErrorStatus, retryableProvider401 } from "./error-code.ts";

export const PROVIDER_RETRIES = 5;
export const PROVIDER_RETRY_DELAY_MS = 3000;
export const PROVIDER_COOLDOWN_MS = 300000;

type Pair = { provider: string; id: string };

type State = { until: number; probing: boolean; recovering: boolean };

type Clock = { now(): number; wait(ms: number, signal?: AbortSignal): Promise<void> };

export type AvailabilityNotice = {
  provider: string;
  model: string;
  retry: number;
  maxRetries: number;
  delayMs: number;
};

export class ProviderHeldError extends Error {
  constructor(
    public remainingMs: number,
    public recovering = false,
  ) {
    super(
      recovering
        ? "Model recovery already in progress"
        : `Model request held by availability guard for ${Math.ceil(remainingMs / 1000)} seconds`,
    );
  }
}

export class RecoveryAuditError extends Error {
  readonly code = "PI_RECOVERY_AUDIT";

  constructor() {
    super("Provider recovery audit failed; no fallback, nothing executed");
  }
}

/** Compiled extensions have separate constructors, but share availability state. */
export function isProviderHeldError(error: unknown): error is ProviderHeldError {
  if (!(error instanceof Error)) return false;

  const candidate = error as Partial<ProviderHeldError>;

  return (
    typeof candidate.remainingMs === "number" &&
    Number.isFinite(candidate.remainingMs) &&
    candidate.remainingMs >= 0 &&
    typeof candidate.recovering === "boolean" &&
    error.message === new ProviderHeldError(candidate.remainingMs, candidate.recovering).message
  );
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
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();

    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Operation aborted"));
    };

    signal?.addEventListener("abort", abort, { once: true });
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

/** State is scoped to each provider/model pair; a successful response ends the outage. */
export class ProviderAvailability {
  private readonly states = new Map<string, State>();
  private readonly clock: Clock;

  constructor(clock: Partial<Clock> = {}) {
    // Wall time includes machine standby on platforms where performance.now() pauses.
    this.clock = { now: () => Date.now(), wait: abortableWait, ...clock };
  }

  /** Explicit operator continuation permits one early probe, never a parallel recovery. */
  requestProbe(pair: Pair): boolean {
    const state = this.states.get(JSON.stringify([pair.provider, pair.id]));

    if (!state || state.probing || state.recovering) return false;

    state.until = 0;

    return true;
  }

  async run<T>(
    pair: Pair,
    work: () => Promise<T>,
    unavailable: (value: T) => boolean,
    signal?: AbortSignal,
    notice?: (event: AvailabilityNotice) => void,
  ): Promise<T> {
    signal?.throwIfAborted();

    const key = JSON.stringify([pair.provider, pair.id]);
    let state = this.states.get(key);
    const probe = !!state && !state.recovering;

    if (state && (state.probing || state.recovering || state.until > this.clock.now()))
      throw new ProviderHeldError(
        Math.max(0, state.until - this.clock.now()),
        state.probing || state.recovering,
      );

    if (state) state.probing = true;

    const retries = probe ? 0 : PROVIDER_RETRIES;

    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        let result: T;

        try {
          result = await interruptible(work, signal);
          signal?.throwIfAborted();

          if (!unavailable(result)) {
            this.states.delete(key);

            return result;
          }
        } catch (error) {
          signal?.throwIfAborted();

          if (isProviderHeldError(error) || !transientProviderError(error)) {
            this.states.delete(key);

            throw error;
          }

          if (attempt === retries) {
            this.markDown(key, state);

            throw new ProviderHeldError(PROVIDER_COOLDOWN_MS);
          }

          result = undefined as T;
        }

        if (attempt === retries) {
          this.markDown(key, state);

          return result;
        }

        if (!state) {
          if (this.states.has(key)) throw new ProviderHeldError(0, true);

          state = { until: 0, probing: false, recovering: true };
          this.states.set(key, state);
        }

        try {
          notice?.({
            provider: pair.provider,
            model: pair.id,
            retry: attempt + 1,
            maxRetries: retries,
            delayMs: PROVIDER_RETRY_DELAY_MS,
          });
        } catch {
          throw new RecoveryAuditError();
        }

        await this.clock.wait(PROVIDER_RETRY_DELAY_MS, signal);
      }

      throw new Error("Availability attempt limit violated");
    } finally {
      if (state && this.states.get(key) === state && (state.recovering || state.probing))
        this.states.delete(key);
    }
  }

  private markDown(key: string, owner?: State) {
    if (owner && this.states.get(key) !== owner) return;

    this.states.set(key, {
      until: this.clock.now() + PROVIDER_COOLDOWN_MS,
      probing: false,
      recovering: false,
    });
  }
}

const sharedKey = Symbol.for("pi.auto-approval.provider-availability.v1");
const shared = globalThis as typeof globalThis & { [sharedKey]?: ProviderAvailability };
export const providerAvailability = (shared[sharedKey] ??= new ProviderAvailability());
