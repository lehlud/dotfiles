import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RemoteController } from "./controller.ts";
import { registerRemoteContext } from "../shared/session/remote.ts";

export default function remoteWorkspace(pi: ExtensionAPI) {
  const controller = new RemoteController(pi);

  registerRemoteContext(pi);
  pi.on("session_start", (_event, ctx) => controller.bind(ctx));
  pi.on("session_tree", (_event, ctx) => controller.bind(ctx));

  const stop = () => {
    controller.detach();
    controller.cancelSelection();

    return controller.stop();
  };

  pi.on("session_before_switch", stop);
  pi.on("session_before_tree", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_shutdown", stop);
  pi.on("agent_end", (event) => {
    if (
      event.messages.some(
        (message) => message.role === "assistant" && message.stopReason === "aborted",
      )
    )
      return controller.stop();
  });
  pi.registerCommand("remote", {
    description:
      "Select an SSH workspace: /remote [user@host:folder | status | off | tunnels | close <id>]",
    async handler(args, ctx) {
      try {
        await controller.command(args, ctx);
      } catch (error) {
        ctx.ui.notify(
          `Remote: ${error instanceof Error ? error.message : "Operation failed"}`,
          "error",
        );
      }
    },
  });
}
