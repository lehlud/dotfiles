import { readFile } from "node:fs/promises";

const modules = [
  "protocol",
  "processes",
  "files",
  "search",
  "commands",
  "cip",
  "cip_paths",
  "worker",
];

/** Load a small package in memory: explicit Python imports without remote installation or files. */
export const workerSource = Promise.all(
  modules.map(async (name) => [
    name,
    await readFile(new URL(`./${name}.py`, import.meta.url), "utf8"),
  ]),
).then((entries) => {
  const sources = JSON.stringify(Object.fromEntries(entries));

  return [
    "import json, sys, types",
    `sources = json.loads(${JSON.stringify(sources)})`,
    'package = types.ModuleType("pi_remote")',
    "package.__path__ = []",
    'sys.modules["pi_remote"] = package',
    "for name, source in sources.items():",
    '    module = types.ModuleType("pi_remote." + name)',
    '    module.__package__ = "pi_remote"',
    '    module.__file__ = "/pi-remote/" + name + ".py"',
    "    sys.modules[module.__name__] = module",
    "    setattr(package, name, module)",
    '    exec(compile(source, module.__file__, "exec"), module.__dict__)',
    'sys.modules["pi_remote.worker"].run()',
  ].join("\n");
});
