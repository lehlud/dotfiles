import { readFile, access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "../shared/contracts/action.ts";
import { isWebTool } from "./index.ts";

const source = dirname(fileURLToPath(import.meta.url));

export type WebRuntime = { dependencies: string; worker: string };

export async function resolveWebRuntime(): Promise<WebRuntime> {
  if (process.platform !== "linux")
    throw new Error("Prepare the web-research Python runtime inside the Linux Lubox container");

  const base = join(
    homedir(),
    ".local/cache/pi-web-research",
    `${process.platform}-${process.arch}`,
  );
  const manifest = JSON.parse(await readFile(join(base, "runtime.json"), "utf8"));
  const dependencies = await realpath(manifest.dependencies);

  if (!dependencies.startsWith(`${await realpath(base)}/`))
    throw new Error("Invalid web-research runtime path");

  await access(join(dependencies, "ddgs/__init__.py"));
  await access(join(dependencies, "trafilatura/__init__.py"));

  return { dependencies, worker: join(source, "worker.py") };
}

export function reviewedWebRequest(request: Request): Request {
  if (!isWebTool(request.tool)) return request;

  if (request.sandbox?.network === "none")
    throw new Error("Web research requires per-operation network access");

  return { ...request, sandbox: { ...request.sandbox, network: "host" } };
}
