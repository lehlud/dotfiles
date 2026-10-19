import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "./git-process.ts";

const strategies = new Set(["ort", "recursive", "resolve", "octopus", "ours", "subtree"]);
const signingPrograms = new Set(
  ["gpg", "gpg2", "gpgsm", "ssh-keygen"].flatMap((name) => [name, `/usr/bin/${name}`]),
);

function validateStrategy(strategy: string) {
  if (!strategies.has(strategy)) {
    throw new Error("The Git-only rebase route supports only built-in merge strategies");
  }
}

function optionName(argument: string, name: string): boolean {
  const option = argument.split("=", 1)[0];

  return option.length > 2 && name.startsWith(option);
}

/** Reject direct shell steps, editor scripts and external strategies before review. */
export function validateRebaseArgv(argv: string[]): void {
  for (let index = 1; index < argv.length && argv[index] !== "--"; index++) {
    const argument = argv[index];

    if (["--exec", "--interactive", "--edit-todo"].some((name) => optionName(argument, name))) {
      throw new Error(
        "Rebase shell steps and interactive sequence editing are excluded from the Git-only route",
      );
    }

    if (optionName(argument, "--strategy")) {
      validateStrategy(
        argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : (argv[++index] ?? ""),
      );

      continue;
    }

    if (!argument.startsWith("-") || argument.startsWith("--")) continue;

    for (let offset = 1; offset < argument.length; offset++) {
      const flag = argument[offset];

      if (["x", "i"].includes(flag)) {
        throw new Error(
          "Rebase shell steps and interactive sequence editing are excluded from the Git-only route",
        );
      }

      if (flag === "s") {
        validateStrategy(argument.slice(offset + 1) || argv[++index] || "");

        break;
      }

      // The rest of an option's value is not a cluster of short flags.
      if (["X", "C", "S"].includes(flag)) {
        if (flag !== "S" && offset === argument.length - 1) index++;

        break;
      }
    }
  }
}

async function controlFile(path: string): Promise<string | undefined> {
  let handle;

  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    const stat = await handle.stat();

    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error("Rebase state must be a bounded regular file");
    }

    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;

    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);

      if (bytesRead === 0) break;

      length += bytesRead;
    }

    if (length > 1024 * 1024) throw new Error("Rebase state exceeds the validation limit");

    return buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;

    throw error;
  } finally {
    await handle?.close();
  }
}

function validateConfiguration(text: string) {
  for (const record of text.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\n");
    const key = (separator < 0 ? record : record.slice(0, separator)).toLowerCase();
    const value = separator < 0 ? "true" : record.slice(separator + 1).trim();

    if (
      value &&
      /^(?:filter\..+\.(?:clean|smudge|process)|merge\..+\.driver|branch\..+\.mergeoptions)$/.test(
        key,
      )
    ) {
      throw new Error(
        "Rebase with repository filter programs, merge drivers or implicit merge options requires a separately reviewed tool workflow",
      );
    }

    if (value && /^gpg(?:\..+)?\.program$/.test(key) && !signingPrograms.has(value)) {
      throw new Error("Custom signing programs are excluded from the Git-only rebase route");
    }
  }
}

/** Validate existing sequencer state inside the approved sandbox without exposing config values. */
export async function validateRebaseState(argv: string[], run: GitRunner): Promise<void> {
  const config = await run(["config", "--null", "--list", "--includes"]);

  if (config.exitCode !== 0) throw new Error("Repository Git configuration could not be parsed");

  validateConfiguration(config.stdout);

  // Recovery remains possible even if an earlier interactive operation included shell steps.
  if (argv.includes("--abort") || argv.includes("--quit")) return;

  const location = await run(["rev-parse", "--absolute-git-dir"]);

  if (location.exitCode !== 0) return;

  const directory = location.stdout.replace(/\n$/, "");
  const todo = await controlFile(join(directory, "rebase-merge", "git-rebase-todo"));

  if (todo && /^\s*(?:exec|x)\s/m.test(todo)) {
    throw new Error("Pending rebase contains shell steps; the Git-only route cannot execute them");
  }

  const strategy = await controlFile(join(directory, "rebase-merge", "strategy"));

  if (strategy?.trim()) validateStrategy(strategy.trim());
}
