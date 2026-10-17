import { spawn } from "node:child_process";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringDecoder } from "node:string_decoder";

import {
  credentialNameSchema as name,
  environmentNameSchema as environmentName,
  credentialValueSchema as value,
} from "../shared/configuration/credential-profile.ts";

export type { CredentialProfile } from "../shared/configuration/credential-profile.ts";

export const credentialCommandTool: ToolDefinition<any, any> = {
  name: "credential_exec",
  label: "Authenticated command",
  description:
    "One argv-only command using an operator-owned program/login binding. The independent reviewer authorizes the full argv and service effects; profiles may add an operator argument allowlist. github binds native gh to its existing login without a fixed subcommand list. Request network: true for remote access, sandbox.projectFiles: read/write for current-project access or sandbox.paths for selected files. No shell, shared /tmp, inherited environment or login-file mounts. Every command and access expansion requires its own review. Other program/login bindings must be configured by the operator outside Pi.",
  parameters: Type.Object(
    { profile: name, argv: Type.Array(value, { minItems: 1, maxItems: 64 }) },
    { additionalProperties: false },
  ),
  renderCall(args: any, theme, context) {
    const command = JSON.stringify(args.argv ?? []);

    return new Text(
      theme.fg(
        "toolTitle",
        `Authenticated command · ${args.profile ?? ""}\n${context.expanded ? command : command.slice(0, 300) + (command.length > 300 ? " … (ctrl+o)" : "")}`,
      ),
      0,
      0,
    );
  },

  async execute() {
    throw new Error("Credential commands require the approved private executor channel");
  },
};

export type CredentialExecution = {
  executable: string;
  argv: string[];
  environment: Record<string, string>;
  redact: string[];
  maxOutputBytes: number;
};

const executionSchema = Type.Object(
  {
    executable: Type.Literal("/opt/pi-credential/tool"),
    argv: Type.Array(value, { maxItems: 64 }),
    environment: Type.Record(environmentName, value, { maxProperties: 64 }),
    redact: Type.Array(value, { maxItems: 32 }),
    maxOutputBytes: Type.Integer({ minimum: 1024, maximum: 268435456 }),
  },
  { additionalProperties: false },
);

/** Only the fixed process receives secrets; no shell, pager or inherited environment. */
export async function executeCredentialCommand(input: unknown) {
  if (!Check(executionSchema, input)) throw new Error("Invalid private credential execution");

  const execution = input as CredentialExecution;
  const child = spawn(execution.executable, execution.argv, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp/home", LANG: "C.UTF-8", ...execution.environment },
  });
  let bytes = 0,
    exceeded = false;
  const streams = {
    stdout: { text: "", decoder: new StringDecoder("utf8") },
    stderr: { text: "", decoder: new StringDecoder("utf8") },
  };
  const collect = (stream: keyof typeof streams, chunk: Buffer) => {
    bytes += chunk.length;

    if (bytes > execution.maxOutputBytes) {
      exceeded = true;
      child.kill("SIGKILL");

      return;
    }

    streams[stream].text += streams[stream].decoder.write(chunk);
  };

  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));

  const exitCode = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });

  if (exceeded) throw new Error("Authenticated command output limit exceeded");

  let output =
    streams.stdout.text +
    streams.stdout.decoder.end() +
    streams.stderr.text +
    streams.stderr.decoder.end();

  for (const secret of execution.redact.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
      JSON.stringify(secret).slice(1, -1),
    ]))
      output = output.split(variant).join("[REDACTED]");
  }

  return {
    content: [{ type: "text" as const, text: output }],
    details: { exitCode },
    ...(exitCode !== 0 ? { isError: true } : {}),
  };
}
