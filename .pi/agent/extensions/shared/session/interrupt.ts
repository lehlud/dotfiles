import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Readable } from "node:stream";

/** Observe RPC cancellation without consuming, replacing or logging its input. */
export function watchRpcAbort(input: Readable, interrupt: () => void) {
  let line = "",
    oversized = false;
  const receive = (chunk: Buffer | string) => {
    for (const part of chunk.toString().split(/(?<=\n)/)) {
      if (!oversized) {
        if (line.length + part.length > 4096) {
          line = "";
          oversized = true;
        } else line += part;
      }

      if (part.endsWith("\n")) {
        if (!oversized) {
          try {
            const command = JSON.parse(line);

            if (command && !Array.isArray(command) && command.type === "abort") interrupt();
          } catch {
            /* The RPC reader owns invalid input reporting. */
          }
        }

        line = "";
        oversized = false;
      }
    }
  };

  input.on("data", receive);

  return () => {
    input.off("data", receive);
    line = "";
    oversized = false;
  };
}

export function watchInterrupt(
  ctx: ExtensionContext,
  active: () => boolean,
  interrupt: () => Promise<void>,
  consume = true,
) {
  const run = () => {
    if (active())
      void interrupt().catch(() =>
        ctx.ui.notify("Agent cancellation failed; inspect the runtime before resuming.", "error"),
      );
  };

  if (ctx.mode === "rpc") return watchRpcAbort(process.stdin, run);

  if (ctx.mode === "tui")
    return (
      ctx.ui.onTerminalInput?.((data) => {
        if (active() && (matchesKey(data, "escape") || data === "\x03")) {
          run();

          if (consume) return { consume: true };
        }
      }) ?? (() => {})
    );

  return () => {};
}
