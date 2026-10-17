import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const value = Type.String({ maxLength: 16384, pattern: "^[^\\u0000]*$" });
export const gitTool: ToolDefinition<any, any> = {
  name: "git",
  label: "Local Git command",
  description:
    "One reviewed local Git command, as argv without a shell. Supports status, diff, show, log, add, commit, rev-parse, ls-files, ls-tree and describe. Request sandbox.gitConfig: true to use the operator's public global Git settings and identity read-only for this command. No credentials, network, aliases, external hooks, or config editing through this route.",
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
]);

export function validateGitArgv(argv: string[]): void {
  if (!commands.has(argv[0]))
    throw new Error(
      "Unsupported local Git command; global options, aliases, remote and destructive commands are excluded",
    );

  if (argv.some((arg) => /^(?:--ext-diff|--textconv)(?:=|$)/.test(arg)))
    throw new Error("External Git diff programs are excluded");
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
    GIT_EDITOR: "false",
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
  }

  const child = spawn("/usr/bin/git", [...fixed, ...argv], {
    cwd: process.cwd(),
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const streams = {
    stdout: { text: "", decoder: new StringDecoder("utf8") },
    stderr: { text: "", decoder: new StringDecoder("utf8") },
  };
  let bytes = 0,
    exceeded = false;
  const collect = (name: keyof typeof streams, chunk: Buffer) => {
    bytes += chunk.length;

    if (bytes > 1024 * 1024) {
      exceeded = true;
      child.kill("SIGKILL");

      return;
    }

    streams[name].text += streams[name].decoder.write(chunk);
  };

  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));

  const exitCode = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });

  if (exceeded) throw new Error("Git output limit exceeded");

  const stdout = streams.stdout.text + streams.stdout.decoder.end(),
    stderr = streams.stderr.text + streams.stderr.decoder.end();

  if (reader && exitCode !== 0) throw new Error("Global Git configuration could not be parsed");

  return {
    content: [{ type: "text" as const, text: stdout + (reader ? "" : stderr) }],
    details: { exitCode },
    ...(exitCode !== 0 ? { isError: true } : {}),
  };
}
