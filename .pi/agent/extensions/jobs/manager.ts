import { randomUUID } from "node:crypto";
import {
  FOREGROUND_JOB_MS,
  type ForegroundResult,
  type JobAccess,
  type JobInfo,
  type JobResult,
  type JobSpec,
} from "../shared/contracts/jobs.ts";

type Job = {
  info: JobInfo;
  controller: AbortController;
  done: Promise<JobResult>;
  result?: JobResult;
  consumed: boolean;
  waiting: boolean;
  silent?: boolean;
  foreground: boolean;
};

type Effects = {
  started(info: JobInfo): void;
  completed(info: JobInfo, result: JobResult): void;
  notify(info: JobInfo, result: JobResult): void;
  changed(): void;
  error(error: unknown): void;
};

export class JobManager implements JobAccess {
  private jobs = new Map<string, Job>();
  private closing = false;
  private suspended = false;
  private stopping?: Promise<void>;
  private listeners = new Set<() => void>();
  revision = 0;
  constructor(
    private effects: Effects,
    private foregroundMs = FOREGROUND_JOB_MS,
  ) {}

  get busy() {
    return this.list().some((job) => job.state === "running");
  }
  list() {
    return [...this.jobs.values()].filter((job) => !job.foreground).map((job) => ({ ...job.info }));
  }

  start(spec: JobSpec, run: (signal: AbortSignal) => Promise<JobResult>) {
    return { ...this.create(spec, run, false).info };
  }

  private create(
    spec: JobSpec,
    run: (signal: AbortSignal) => Promise<JobResult>,
    foreground: boolean,
  ) {
    if (this.closing || this.suspended)
      throw new Error(
        "Job supervisor is interrupted or closing; resume the run before starting another job",
      );

    if ([...this.jobs.values()].filter((job) => job.info.state === "running").length >= 4)
      throw new Error(
        "Four supervised commands are already running; join one before starting another",
      );

    const info: JobInfo = { ...spec, id: randomUUID(), state: "running", started: Date.now() };

    // Foreground execution already has its durable action approval. Background
    // admission is journaled before launch or promotion becomes visible.
    if (!foreground) this.effects.started({ ...info });

    const job: Job = {
      info,
      controller: new AbortController(),
      done: undefined!,
      consumed: false,
      waiting: false,
      foreground,
    };

    this.jobs.set(info.id, job);

    if (!foreground) this.changed();

    job.done = Promise.resolve().then(() => this.execute(job, run));

    return job;
  }

  /** Yield the existing executor after two minutes; never restart or detach it. */
  async runForeground(
    spec: JobSpec,
    run: (signal: AbortSignal) => Promise<JobResult>,
    signal?: AbortSignal,
  ): Promise<ForegroundResult> {
    signal?.throwIfAborted();

    const job = this.create(spec, run, true);
    const abort = () => job.controller.abort(signal?.reason);
    let timer: ReturnType<typeof setTimeout> | undefined;

    signal?.addEventListener("abort", abort, { once: true });

    try {
      const promoted = new Promise<ForegroundResult>((resolve, reject) => {
        timer = setTimeout(() => {
          if (job.result) return resolve({ result: job.result });

          try {
            this.effects.started({ ...job.info });
            job.foreground = false;
            signal?.removeEventListener("abort", abort);
            this.changed();
            resolve({ job: { ...job.info } });
          } catch (error) {
            reject(error);
          }
        }, this.foregroundMs);
      });

      return await Promise.race([job.done.then((result) => ({ result })), promoted]);
    } catch (error) {
      job.controller.abort(error);
      await job.done;

      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);

      if (job.foreground) this.jobs.delete(job.info.id);
    }
  }

  private async execute(job: Job, run: (signal: AbortSignal) => Promise<JobResult>) {
    let result: JobResult;

    try {
      result = await run(job.controller.signal);
    } catch (error) {
      result = {
        content: [{ type: "text", text: `Job failed: ${String(error)}` }],
        details: undefined,
        isError: true,
      };
    }

    job.info.state = job.controller.signal.aborted
      ? "cancelled"
      : result.isError
        ? "failed"
        : "succeeded";
    job.info.finished = Date.now();

    if (job.controller.signal.aborted) result = { ...result, isError: true };

    job.result = result;

    if (job.foreground) return result;

    try {
      this.effects.completed({ ...job.info }, result);
    } catch (error) {
      result = {
        content: [
          {
            type: "text",
            text: `Execution ended but its audit could not be recorded: ${String(error)}`,
          },
        ],
        details: undefined,
        isError: true,
      };
      job.result = result;
      job.info.state = "failed";
      this.effects.error(error);
    }

    this.changed();

    if (!this.closing && !job.waiting) this.deliver(job);

    this.prune();

    return result;
  }

  private changed() {
    this.revision++;
    this.effects.changed();

    for (const notify of this.listeners) notify();
  }

  private deliver(job: Job) {
    if (job.consumed || job.silent || !job.result) return;

    try {
      this.effects.notify({ ...job.info }, job.result);
      job.consumed = true;
    } catch (error) {
      this.effects.error(error);
    }
  }

  private get(id: string) {
    const job = this.jobs.get(id);

    if (!job)
      throw new Error(
        "Unknown job in this session; jobs are not resumed across session replacement or reload",
      );

    return job;
  }

  private prune() {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= 32) break;

      if (job.result && job.consumed && !job.waiting) this.jobs.delete(id);
    }
  }

  async wait(id: string | undefined, signal?: AbortSignal) {
    signal?.throwIfAborted();

    const jobs = id
      ? [this.get(id)]
      : [...this.jobs.values()].filter(
          (job) => !job.foreground && (job.info.state === "running" || !job.consumed),
        );

    if (!jobs.length)
      throw new Error(
        "No unconsumed jobs; completion is delivered automatically. Do independent work or finish the turn instead of polling.",
      );

    if (jobs.some((job) => job.waiting))
      throw new Error(
        "A join already waits for this job; handle its result instead of starting another wait",
      );

    for (const job of jobs) job.waiting = true;

    try {
      const results = await abortable(Promise.all(jobs.map((job) => job.done)), signal);

      for (const job of jobs) job.consumed = true;

      return jobs.map((job, index) => ({ job: { ...job.info }, result: results[index] }));
    } finally {
      for (const job of jobs) {
        job.waiting = false;

        if (!this.closing) this.deliver(job);
      }

      this.prune();
    }
  }

  async cancel(id: string) {
    const job = this.get(id);

    job.controller.abort(new Error("Job cancelled"));
    await job.done;

    return { ...job.info };
  }

  /** Timers and event listeners keep the model idle; no provider requests or status probes. */
  async sleep(seconds: number, signal?: AbortSignal) {
    signal?.throwIfAborted();

    return new Promise<string>((resolve, reject) => {
      const finish = (reason: string) => {
        cleanup();
        resolve(reason);
      };
      const wake = () => finish("Job activity; inspect the automatically delivered completion");
      const aborted = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Wait interrupted"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(wake);
        signal?.removeEventListener("abort", aborted);
      };
      const timer = setTimeout(() => finish("Sleep interval elapsed"), seconds * 1000);

      this.listeners.add(wake);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  async stop() {
    this.closing = true;
    await this.cancelAll();
  }

  async cancelAll() {
    this.suspended = true;

    const jobs = [...this.jobs.values()];

    for (const job of jobs)
      if (job.info.state === "running") {
        job.silent = true;
        job.consumed = true;
        job.controller.abort(new Error("Session interrupted or closed"));
      }

    for (const wake of [...this.listeners]) wake();

    this.stopping = Promise.allSettled(jobs.map((job) => job.done)).then(() => {});
    await this.stopping;
  }

  async resume() {
    await this.stopping;

    if (!this.closing) this.suspended = false;
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Wait interrupted"));
    };

    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
