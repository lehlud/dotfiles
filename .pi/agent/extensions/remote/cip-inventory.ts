import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { CIP_HOST } from "./host-keys.ts";

export type CipMachine = { host: string; room: string; cores: number; ramGiB: number; gpu: string };

export type CipRequirements = {
  host?: string;
  gpu?: boolean;
  minRamGiB?: number;
  minCores?: number;
  gpuModel?: string;
};

export function cipHostname(input: string) {
  const host = input.includes(".") ? input : `${input}.cip.cs.fau.de`;

  if (!CIP_HOST.test(host)) throw new Error("Use a CIP workstation name, e.g. cip7b0");

  return host;
}

export function parseCipInventory(text: string): CipMachine[] {
  if (text.length > 262144) throw new Error("CIP inventory exceeds its bound");

  const machines = text
    .trim()
    .split("\n")
    .slice(1)
    .map((row) => {
      const [host, room, , cores, ram, gpu] = row.split("\t");

      if (!room || gpu === undefined || !/^\d+$/.test(cores) || !/^\d+$/.test(ram))
        throw new Error("Invalid faucip TSV inventory");

      return { host: cipHostname(host), room, cores: Number(cores), ramGiB: Number(ram), gpu };
    });

  if (
    !machines.length ||
    machines.length > 512 ||
    new Set(machines.map((machine) => machine.host)).size !== machines.length
  )
    throw new Error("Empty or duplicate CIP inventory");

  return machines;
}

export async function cipInventory(signal?: AbortSignal) {
  signal?.throwIfAborted();

  const child = Bun.spawn([join(homedir(), ".local/bin/faucip"), "--list-tsv"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
    signal,
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();

  if ((await child.exited) !== 0) throw new Error(`faucip inventory failed: ${error.slice(-500)}`);

  return parseCipInventory(output);
}

export async function cipUsername() {
  const cache =
    process.env.FAUCIP_USER_CACHE_FILE ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "faucipuser.txt");
  let user = "";

  try {
    user = (await readFile(cache, "utf8")).split("\n")[0].trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (user && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(user))
    throw new Error("Invalid cached faucip username");

  return user;
}

export function cipCandidates(
  machines: CipMachine[],
  requirements: CipRequirements,
  excluded: Set<string>,
) {
  const host = requirements.host ? cipHostname(requirements.host) : undefined;
  const result = machines.filter(
    (machine) =>
      !excluded.has(machine.host) &&
      (!host || machine.host === host) &&
      (!requirements.gpu || Boolean(machine.gpu)) &&
      (!requirements.minRamGiB || machine.ramGiB >= requirements.minRamGiB) &&
      (!requirements.minCores || machine.cores >= requirements.minCores) &&
      (!requirements.gpuModel ||
        machine.gpu.toLowerCase().includes(requirements.gpuModel.toLowerCase())),
  );

  for (let i = result.length - 1; i > 0; i--) {
    const other = randomInt(i + 1);

    [result[i], result[other]] = [result[other], result[i]];
  }

  return result;
}
