import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type GitOutput = { stdout: string; stderr: string; exitCode: number | null };

export type GitRunner = (argv: string[]) => Promise<GitOutput>;

/** Bounded output stays private until the caller selects what can be returned. */
export async function runGit(argv: string[], env: NodeJS.ProcessEnv): Promise<GitOutput> {
  const child = spawn("/usr/bin/git", argv, {
    cwd: process.cwd(),
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const streams = {
    stdout: { text: "", decoder: new StringDecoder("utf8") },
    stderr: { text: "", decoder: new StringDecoder("utf8") },
  };
  let bytes = 0;
  let exceeded = false;
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

  return {
    stdout: streams.stdout.text + streams.stdout.decoder.end(),
    stderr: streams.stderr.text + streams.stderr.decoder.end(),
    exitCode,
  };
}
