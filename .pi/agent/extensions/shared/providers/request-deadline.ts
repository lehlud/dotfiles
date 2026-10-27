type Deadline = { pause(): () => void };

const key = Symbol.for("pi.request-deadlines.v1");
const shared = globalThis as typeof globalThis & { [key]?: WeakMap<AbortSignal, Deadline> };
const deadlines = (shared[key] ??= new WeakMap<AbortSignal, Deadline>());

/** Count active request time; provider recovery waits suspend this deadline and its parent. */
export function requestDeadline(
  signal: AbortSignal,
  timeoutMs: number,
  expire: () => void,
  parent?: AbortSignal,
) {
  let remaining = timeoutMs;
  let started = Date.now();
  let timer = setTimeout(expire, remaining);
  let paused = 0;
  let closed = false;
  const deadline: Deadline = {
    pause() {
      const resumeParent = parent ? deadlines.get(parent)?.pause() : undefined;

      if (paused++ === 0) {
        clearTimeout(timer);
        remaining -= Date.now() - started;
      }

      return () => {
        resumeParent?.();

        if (--paused === 0 && !closed) {
          started = Date.now();
          timer = setTimeout(expire, Math.max(0, remaining));
        }
      };
    },
  };

  deadlines.set(signal, deadline);

  return () => {
    closed = true;
    clearTimeout(timer);
    deadlines.delete(signal);
  };
}

export async function providerWait<T>(signal: AbortSignal | undefined, wait: () => Promise<T>) {
  const resume = signal ? deadlines.get(signal)?.pause() : undefined;

  try {
    return await wait();
  } finally {
    resume?.();
  }
}
