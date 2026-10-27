import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CIP_HOST = /^cip[0-9][a-z0-9-]*\.cip\.cs\.fau\.de$/;
const operatorKeys = () => join(homedir(), ".ssh", "known_hosts");
const cipKeys = () => join(homedir(), ".pi", "agent", "cip-known-hosts");

async function lookup(host: string, path: string) {
  const executable = Bun.which("ssh-keygen");

  if (!executable?.startsWith("/usr/")) throw new Error("Native OpenSSH ssh-keygen is required");

  const child = Bun.spawn([executable, "-F", host, "-f", path], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 10000,
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  const code = await child.exited;

  if (code !== 0) {
    if ((code === 1 && !error.trim()) || error.includes("No such file")) return;

    throw new Error("Cannot read the public SSH host-key database");
  }

  return (
    output
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .join("\n") + "\n"
  );
}

/** Re-read public trust on every preparation; operator keys take precedence over CIP TOFU. */
export async function knownHostKeys(host: string) {
  const keys =
    (await lookup(host, operatorKeys())) ??
    (CIP_HOST.test(host) ? await lookup(host, cipKeys()) : undefined);

  if (!keys?.trim())
    throw new Error(
      `Host key for ${host} is not trusted. Verify/add it with OpenSSH, then retry /remote; no restart is needed.`,
    );

  return keys;
}

/** /cip explicitly authorizes first-use trust for this domain; existing/changed pins are never replaced. */
export async function acceptCipHostKey(host: string) {
  if (!CIP_HOST.test(host))
    throw new Error("Automatic host-key trust is restricted to CIP workstations");

  try {
    return await knownHostKeys(host);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Host key for ")) throw error;
  }

  const executable = Bun.which("ssh-keyscan");

  if (!executable?.startsWith("/usr/")) throw new Error("Native OpenSSH ssh-keyscan is required");

  const child = Bun.spawn([executable, "-T", "5", "-t", "ed25519,ecdsa,rsa", host], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 10000,
  });
  const output = await new Response(child.stdout).text();
  const diagnostic = await new Response(child.stderr).text();

  if ((await child.exited) !== 0 || output.length > 16384)
    throw new Error(
      `CIP host-key discovery failed: ${JSON.stringify(diagnostic.trim().slice(-300))}`,
    );

  const lines = output.split("\n").filter((line) => line.trim() && !line.startsWith("#"));

  if (
    !lines.length ||
    lines.some(
      (line) =>
        !new RegExp(
          `^${host.replaceAll(".", "\\.")} (?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/=]+$`,
        ).test(line),
    )
  )
    throw new Error("Invalid CIP host key");

  const path = cipKeys();

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );

  try {
    await file.writeFile(lines.join("\n") + "\n");
  } finally {
    await file.close();
  }

  return await knownHostKeys(host);
}
