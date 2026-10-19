import { Type } from "typebox";
import { Check } from "typebox/value";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGit } from "./git-process.ts";
import { validateRebaseArgv, validateRebaseState } from "./git-rebase.ts";

const value = Type.String({ maxLength: 16384, pattern: "^[^\\u0000]*$" });
export const gitTool: ToolDefinition<any, any> = {
  name: "git",
  label: "Local Git command",
  description:
    "One reviewed local Git command, as argv without a shell. Supports status, diff, show, log, add, commit, rev-parse, ls-files, ls-tree, describe and noninteractive rebase, including --continue, --abort and --skip. Request sandbox.gitConfig: true to use the operator's public global settings and identity read-only for this command. Rebase --continue preserves the prepared commit message automatically; do not request GIT_EDITOR or other environment variables. No credentials, network, aliases, hooks, rebase shell steps, interactive sequence editing or config editing through this route.",
  parameters: Type.Object(
    { argv: Type.Array(value, { minItems: 1, maxItems: 64 }) },
    { additionalProperties: false },
  ),
  renderCall(args: any, theme, context) {
    const command = `git ${JSON.stringify(args.argv ?? [])}`;

    return new Text(
      theme.fg(
        "toolTitle",
        context.expanded
          ? command
          : command.slice(0, 300) + (command.length > 300 ? " … (ctrl+o)" : ""),
      ),
      0,
      0,
    );
  },

  async execute() {
    throw new Error("Git commands require the reviewed isolated executor");
  },
};

const commands = new Set([
  "status",
  "diff",
  "show",
  "log",
  "add",
  "commit",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "describe",
  "rebase",
]);

export function validateGitArgv(argv: string[]): void {
  if (!commands.has(argv[0]))
    throw new Error(
      "Unsupported local Git command; only the documented local inspection, commit and rebase operations are supported",
    );

  if (argv.some((arg) => /^(?:--ext-diff|--textconv)(?:=|$)/.test(arg)))
    throw new Error("External Git diff programs are excluded");

  if (argv[0] === "rebase") validateRebaseArgv(argv);
}

// Only the fixed internal offline reader can parse original configuration snapshots.
export type GitConfigReader = { home: string; xdg: string; file?: string; global?: string };

const readerSchema = Type.Object(
  { home: value, xdg: value, file: Type.Optional(value), global: Type.Optional(value) },
  { additionalProperties: false },
);

export async function executeGit(argv: string[], share: boolean, reader?: GitConfigReader) {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: share ? "/opt/pi-git/config" : "/dev/null",
    GIT_PAGER: "cat",
    GIT_EDITOR:
      argv[0] === "rebase" && argv.includes("--continue") ? "/usr/bin/true" : "/usr/bin/false",
    GIT_SEQUENCE_EDITOR: "/usr/bin/false",
  };
  const fixed = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "user.useConfigOnly=true",
  ];

  if (reader) {
    if (!Check(readerSchema, reader)) throw new Error("Invalid private Git configuration reader");

    env.HOME = reader.home;
    env.XDG_CONFIG_HOME = reader.xdg;

    if (reader.global !== undefined) env.GIT_CONFIG_GLOBAL = reader.global;
    else delete env.GIT_CONFIG_GLOBAL;

    argv = [
      "config",
      ...(reader.file ? ["--file", reader.file, "--no-includes"] : ["--global", "--includes"]),
      "--null",
      "--list",
    ];
  } else {
    validateGitArgv(argv);

    if (argv[0] === "rebase") {
      fixed.push("-c", "rebase.instructionFormat=%s", "-c", "rebase.updateRefs=false");
      await validateRebaseState(argv, (args) => runGit([...fixed, ...args], env));
    }
  }

  const { stdout, stderr, exitCode } = await runGit([...fixed, ...argv], env);

  if (reader && exitCode !== 0) throw new Error("Global Git configuration could not be parsed");

  return {
    content: [{ type: "text" as const, text: stdout + (reader ? "" : stderr) }],
    details: { exitCode },
    ...(exitCode !== 0 ? { isError: true } : {}),
  };
}
