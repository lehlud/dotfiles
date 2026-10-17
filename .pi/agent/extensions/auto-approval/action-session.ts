import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeSessionTemporaryDirectory } from "../shared/session/temporary-storage.ts";

/** Review and execution share a queue; cleanup waits for both before removing private storage. */
export class ActionSession {
  private queue: Promise<unknown> = Promise.resolve();
  private temporaryDirectory?: Promise<string>;
  readonly displays = new Set<() => number>();

  temporaryStorage() {
    return (this.temporaryDirectory ??= mkdtemp(join(tmpdir(), "pi-auto-approval-tmp-")));
  }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);

    this.queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  async cleanup() {
    for (const stop of this.displays) stop();

    this.displays.clear();
    await this.queue;

    const directory = this.temporaryDirectory;

    this.temporaryDirectory = undefined;

    if (directory) await removeSessionTemporaryDirectory(await directory);
  }
}
