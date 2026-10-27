import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SideView } from "./side-view.ts";
import { SIDE_PROFILE, type DialogueProfile } from "./side-conversation.ts";
import { NIETZSCHE_PROFILE } from "./nietzsche.ts";

type OpenDialogue = { closed: boolean; view?: SideView; close?: () => void };

async function showDialogue(
  ctx: ExtensionCommandContext,
  opening: OpenDialogue,
  profile: DialogueProfile,
  initial: string,
) {
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) => {
      opening.close = () => done();

      // Session navigation may finish while the UI is still opening.
      if (opening.closed) {
        done();

        return { render: () => [], invalidate() {} };
      }

      opening.view = new SideView(
        tui,
        theme,
        ctx,
        () => {
          opening.view?.dispose();
          done();
        },
        initial,
        profile,
      );

      return opening.view;
    },
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "80%" },
    },
  );
}

export function registerDialogues(pi: ExtensionAPI) {
  let active: OpenDialogue | undefined;
  const close = () => {
    if (active) active.closed = true;

    active?.view?.dispose();
    active?.close?.();
  };

  pi.on("session_shutdown", close);
  pi.on("session_tree", close);
  pi.on("session_start", close);

  const commands = [
    {
      name: "side",
      profile: SIDE_PROFILE,
      description: "Temporary side chat: /side [question]; Escape returns",
    },
    {
      name: "nietzsche",
      profile: NIETZSCHE_PROFILE,
      description: "Question-driven debugging: /nietzsche [problem]; /solved or /give-up inside",
    },
  ];

  for (const { name, profile, description } of commands) {
    pi.registerCommand(name, {
      description,
      async handler(question: string, ctx: ExtensionCommandContext) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(`/${name} requires the interactive terminal interface.`, "warning");

          return;
        }

        if (active) {
          ctx.ui.notify("A dialogue is already open.", "warning");

          return;
        }

        const opening: OpenDialogue = { closed: false };

        active = opening;

        try {
          await showDialogue(ctx, opening, profile, question);
        } catch (error) {
          ctx.ui.notify(
            `${profile.title}: ${error instanceof Error ? error.message : "Startup failed"}`,
            "error",
          );
        } finally {
          opening.view?.dispose();

          if (active === opening) active = undefined;
        }
      },
    });
  }
}
