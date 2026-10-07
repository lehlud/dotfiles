import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SideView } from "./side-view.ts";
type OpenSide = { view?: SideView; close?: () => void };

export function registerSide(pi: ExtensionAPI) {
  let active: OpenSide | undefined;
  const close = () => { active?.view?.dispose(); active?.close?.(); };
  pi.on("session_shutdown", close);
  pi.on("session_tree", close);
  pi.registerCommand("side", {
    description: "Temporärer Seitenchat zum Hauptkontext: /side [Frage]; Escape kehrt zurück",
    async handler(question: string, ctx: ExtensionCommandContext) {
      if (ctx.mode !== "tui") { ctx.ui.notify("/side benötigt die interaktive Terminal-Oberfläche.", "warning"); return; }
      if (active) { ctx.ui.notify("Es ist bereits ein Seitenchat geöffnet.", "warning"); return; }
      const opening: OpenSide = {}; active = opening;
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          opening.close = () => done();
          opening.view = new SideView(tui, theme, ctx, () => { opening.view?.dispose(); done(); }, question);
          return opening.view;
        }, { overlay: true, overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "80%" } });
      } catch (error) { ctx.ui.notify(`Seitenchat: ${error instanceof Error ? error.message : "Start fehlgeschlagen"}`, "error"); }
      finally { opening.view?.dispose(); if (active === opening) active = undefined; }
    },
  });
}
