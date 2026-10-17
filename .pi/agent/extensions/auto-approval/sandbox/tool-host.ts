import { lstat } from "node:fs/promises";
import type { SandboxConfig } from "./types.ts";

/** Only operator-side container markers are considered, before any action starts. */
export async function hasContainerHost(): Promise<boolean> {
  for (const path of ["/run/.containerenv", "/.dockerenv"]) {
    const marker = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;

      throw error;
    });

    if (marker?.isFile() && marker.uid === 0) return true;
  }

  return false;
}

/** Flutter executes in the existing container, with isolation inside that boundary. */
export async function assertToolHost(
  names: readonly string[] | undefined,
  config: SandboxConfig,
  containerHost: () => Promise<boolean> = hasContainerHost,
): Promise<void> {
  if (!names?.some((name) => name === "flutter" || name === "dart")) return;

  if (config.backend !== "bwrap" || (await containerHost())) return;

  throw new Error(
    "Flutter/Dart require a container: run Pi inside Lubox or use its Docker sandbox backend. No host execution or container-engine socket fallback is permitted.",
  );
}
