import { isRetryableAssistantError } from "@earendil-works/pi-ai";

export const PROVIDER_RETRIES = 5;
export const PROVIDER_RETRY_DELAY_MS = 3000;
export const PROVIDER_COOLDOWN_MS = 300000;
type Pair = { provider: string; id: string };
type State = { until: number; probing: boolean; recovering: boolean };
type Clock = { now(): number; wait(ms: number, signal?: AbortSignal): Promise<void> };
export type AvailabilityNotice = { provider: string; model: string; retry: number; maxRetries: number; delayMs: number };

export class ProviderHeldError extends Error {
  constructor(public remainingMs: number, public recovering = false) {
    super(recovering ? "Model recovery already in progress" : `Model request held by availability guard for ${Math.ceil(remainingMs / 1000)} seconds`);
  }
}
export class RecoveryAuditError extends Error {
  constructor() { super("Provider recovery audit failed; no fallback, nothing executed"); }
}
export function transientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/refusal|(?:reviewer|model|policy|request).*(?:refus|block)|content.filter|safety|context.*(?:length|window|overflow)|invalid.*schema|schema.*invalid|unsupported.*param|401|403|api.?key|authentication|quota|billing|out of budget/i.test(message)) return false;
  return /\b5\d\d\b|ECONN|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(message)
    || isRetryableAssistantError({ stopReason: "error", errorMessage: message } as any);
}
function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Operation aborted")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function interruptible<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await work();
  let abort: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason ?? new Error("Operation aborted")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), cancelled]); }
  finally { signal.removeEventListener("abort", abort!); }
}

/** Zustand gilt pro Provider/Modell; ein erfolgreicher Kontakt beendet die Ausfallserie. */
export class ProviderAvailability {
  private readonly states = new Map<string, State>();
  constructor(private clock: Clock = { now: () => performance.now(), wait: abortableWait }) {}
  async run<T>(pair: Pair, work: () => Promise<T>, unavailable: (value: T) => boolean, signal?: AbortSignal, notice?: (event: AvailabilityNotice) => void): Promise<T> {
    signal?.throwIfAborted();
    const key = JSON.stringify([pair.provider, pair.id]);
    let state = this.states.get(key);
    const probe = !!state && !state.recovering;
    if (state && (state.probing || state.recovering || state.until > this.clock.now())) throw new ProviderHeldError(Math.max(0, state.until - this.clock.now()), state.probing || state.recovering);
    if (state) state.probing = true;
    const retries = probe ? 0 : PROVIDER_RETRIES;
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        let result: T;
        try {
          result = await interruptible(work, signal);
          signal?.throwIfAborted();
          if (!unavailable(result)) { this.states.delete(key); return result; }
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof ProviderHeldError || !transientProviderError(error)) { this.states.delete(key); throw error; }
          if (attempt === retries) { this.markDown(key, state); throw new ProviderHeldError(PROVIDER_COOLDOWN_MS); }
          result = undefined as T;
        }
        if (attempt === retries) { this.markDown(key, state); return result; }
        if (!state) {
          if (this.states.has(key)) throw new ProviderHeldError(0, true);
          state = { until: 0, probing: false, recovering: true }; this.states.set(key, state);
        }
        try { notice?.({ provider: pair.provider, model: pair.id, retry: attempt + 1, maxRetries: retries, delayMs: PROVIDER_RETRY_DELAY_MS }); }
        catch { throw new RecoveryAuditError(); }
        await this.clock.wait(PROVIDER_RETRY_DELAY_MS, signal);
      }
      throw new Error("Availability attempt limit violated");
    } finally {
      if (state && this.states.get(key) === state && (state.recovering || state.probing)) this.states.delete(key);
    }
  }
  private markDown(key: string, owner?: State) {
    if (owner && this.states.get(key) !== owner) return;
    this.states.set(key, { until: this.clock.now() + PROVIDER_COOLDOWN_MS, probing: false, recovering: false });
  }
}

const sharedKey = Symbol.for("pi.auto-approval.provider-availability.v1");
const shared = globalThis as typeof globalThis & { [sharedKey]?: ProviderAvailability };
export const providerAvailability = shared[sharedKey] ??= new ProviderAvailability();
