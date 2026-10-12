import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as prettier from "prettier";
import { groupCode } from "./layout.ts";

const root = resolve(import.meta.dir, "../..");
const write = process.argv.includes("--write");
const changed: string[] = [];

for await (const name of new Bun.Glob("**/*.{ts,json,md}").scan(root)) {
  if (name.split("/").includes("node_modules")) continue;

  const path = resolve(root, name);
  const original = await readFile(path, "utf8");
  const options = await prettier.resolveConfig(path);
  const formatted = await prettier.format(original, { ...options, filepath: path });
  const grouped = name.endsWith(".ts") ? groupCode(formatted) : formatted;

  if (original === grouped) continue;

  changed.push(name);

  if (write) await writeFile(path, grouped);

}

if (changed.length) console.log(changed.join("\n"));

console.log(`${write ? "Formatted" : "Checked"} extension layout: ${changed.length} changed files`);

if (!write && changed.length) process.exitCode = 1;

