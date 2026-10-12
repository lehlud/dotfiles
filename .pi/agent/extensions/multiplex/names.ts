import { randomInt } from "node:crypto";

export const AGENT_WORDS: readonly string[] = Object.freeze([
  "acorn",
  "amber",
  "anchor",
  "apple",
  "aspen",
  "badger",
  "beacon",
  "birch",
  "bison",
  "breeze",
  "brook",
  "cedar",
  "cherry",
  "clover",
  "comet",
  "coral",
  "crane",
  "creek",
  "daisy",
  "dawn",
  "delta",
  "dove",
  "dune",
  "eagle",
  "elm",
  "ember",
  "falcon",
  "fern",
  "finch",
  "flint",
  "forest",
  "fox",
  "frost",
  "garnet",
  "glade",
  "grove",
  "harbor",
  "hare",
  "hazel",
  "heron",
  "hill",
  "iris",
  "ivy",
  "jade",
  "jay",
  "juniper",
  "kite",
  "lake",
  "lark",
  "laurel",
  "leaf",
  "lily",
  "lotus",
  "lynx",
  "maple",
  "marble",
  "meadow",
  "mint",
  "moss",
  "oak",
  "olive",
  "opal",
  "otter",
  "owl",
  "pearl",
  "pebble",
  "pine",
  "plum",
  "poppy",
  "quartz",
  "raven",
  "reed",
  "ridge",
  "river",
  "robin",
  "sage",
  "sparrow",
  "spruce",
  "stone",
  "willow",
]);

/** Sample English words without replacement using unbiased cryptographic draws. */
export function randomNames(count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > AGENT_WORDS.length)
    throw new Error("Invalid agent name count");

  const available = [...AGENT_WORDS];

  for (let i = 0; i < count; i++) {
    const selected = randomInt(i, available.length);

    [available[i], available[selected]] = [available[selected], available[i]];
  }

  return available.slice(0, count);
}

