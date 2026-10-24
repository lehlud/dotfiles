import { isAbsolute, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type {
  ContainerWorkspace,
  ContainerReader,
  ContainerFile,
} from "../shared/contracts/containers.ts";

export async function grantedFile(read: ContainerReader, name: string): Promise<ContainerFile> {
  const file = (await read([name]))[0];

  if ("errorCode" in file)
    throw Object.assign(new Error("Container configuration file is unavailable"), {
      code: file.errorCode,
    });

  return file;
}

function dotenv(text: string) {
  const values: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);

    if (!match) continue;

    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);

    values[match[1]] = value;
  }

  return values;
}

function interpolate(value: unknown, environment: Record<string, string>, depth = 0): any {
  if (depth > 40) throw new Error("Container configuration exceeds its nesting bound");

  if (typeof value === "string") {
    const sentinel = "\u0000PI_DOLLAR\u0000";
    const result = value
      .replaceAll("$$", sentinel)
      .replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\?|\?)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (_all, braced, operator, fallback, bare) => {
          const name = braced ?? bare;
          const resolved = environment[name];

          if (operator === ":-" ? !resolved : resolved === undefined) {
            if (operator === ":?" || operator === "?")
              throw new Error(`Missing container configuration variable: ${name}`);

            return fallback ?? "";
          }

          return resolved;
        },
      );

    if (/\$\{/.test(result)) throw new Error("Unsupported container variable expression");

    return result.replaceAll(sentinel, "$");
  }

  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, environment, depth + 1));

  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        interpolate(entry, environment, depth + 1),
      ]),
    );

  return value;
}

function composeArguments(command: string[]) {
  const files: string[] = [],
    envFiles: string[] = [],
    retained: string[] = [];
  let index = 1;

  while (index < command.length && command[index].startsWith("-")) {
    const [name, inline] = command[index].split(/=(.*)/s);
    const value = inline ?? command[++index];

    if (!value) throw new Error("Incomplete Compose option");

    if (["-f", "--file"].includes(name)) files.push(value);
    else if (name === "--env-file") envFiles.push(value);
    else if (name === "--profile")
      throw new Error("Select profiles in a flattened Compose job file");
    else
      throw new Error(
        "Compose jobs use their own isolated project/directory; unsupported global option: " + name,
      );

    index++;
  }

  return { files, envFiles, command: [...retained, ...command.slice(index)] };
}

/** Parse data only. No Compose provider, shell, host environment or project code runs here. */
export async function prepareCompose(
  commands: string[][],
  workspace: ContainerWorkspace,
  literal: Record<string, string>,
  reader: ContainerReader,
) {
  const manifests: Record<string, unknown> = {};
  const sources = new Map<string, { path: string; source: string; sha256: string }>();
  const read = async (name: string) => {
    const cached = sources.get(resolve(workspace.cwd, name));

    if (cached) return cached;

    const file = await grantedFile(reader, name);

    sources.set(file.path, file);

    return file;
  };

  for (const [index, argv] of commands.entries()) {
    if (argv[0] !== "compose" || (argv.length === 2 && argv[1] === "version")) continue;

    const options = composeArguments(argv);
    let environment: Record<string, string> = {};
    const disableEnv = ["true", "1"].includes(literal.COMPOSE_DISABLE_ENV_FILE ?? "");
    const envFiles = options.envFiles.length ? options.envFiles : disableEnv ? [] : [".env"];

    for (const path of envFiles) {
      if (path === "/dev/null") continue;

      try {
        environment = { ...environment, ...dotenv((await read(path)).source) };
      } catch (error) {
        if (options.envFiles.length || (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
    }

    environment = { ...environment, ...literal };

    let files = options.files;

    if (files.length > 1)
      throw new Error(
        "Submit one flattened Compose file; implicit multi-file merge semantics are excluded",
      );

    if (!files.length) {
      for (const name of [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yml",
        "docker-compose.yaml",
      ]) {
        try {
          await read(name);
          files = [name];

          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }

    if (!files.length) throw new Error("No granted Compose file found");

    const base = resolve(workspace.cwd, files[0], "..");

    const file = await read(files[0]);
    const document = parseDocument(file.source, { uniqueKeys: true, strict: true });

    if (document.errors.length || document.warnings.length)
      throw new Error("Compose YAML contains unsupported or invalid syntax");

    const raw = document.toJS({ maxAliasCount: 100 });
    const noInterpolate =
      options.command[0] === "config" && options.command.includes("--no-interpolate");
    const config = noInterpolate ? raw : interpolate(raw, environment);

    if (config.include || config.extends)
      throw new Error(
        "Compose include/extends must be flattened before submitting a container job",
      );

    for (const service of Object.values(config.services ?? {}) as any[]) {
      if (service.extends) throw new Error("Compose service extends must be flattened first");

      const envPaths =
        typeof service.env_file === "string" ? [service.env_file] : (service.env_file ?? []);
      let serviceEnvironment: Record<string, string> = {};

      for (const path of envPaths) {
        if (typeof path !== "string")
          throw new Error("Only explicit granted env_file paths are supported");

        serviceEnvironment = {
          ...serviceEnvironment,
          ...dotenv((await read(resolve(base, path))).source),
        };
      }

      const supplied = Array.isArray(service.environment)
        ? Object.fromEntries(
            service.environment.map((entry: string) => {
              const equal = entry.indexOf("=");

              if (equal < 0)
                throw new Error(
                  "Compose environment requires explicit values; host inheritance is excluded",
                );

              return [entry.slice(0, equal), entry.slice(equal + 1)];
            }),
          )
        : (service.environment ?? {});

      if (Object.values(supplied).some((value) => value === null))
        throw new Error("Compose environment cannot inherit the operator's environment");

      service.environment = { ...serviceEnvironment, ...supplied };
      delete service.env_file;

      const context = typeof service.build === "string" ? service.build : service.build?.context;

      if (context && !isAbsolute(context)) {
        if (typeof service.build === "string") service.build = resolve(workspace.cwd, context);
        else service.build.context = resolve(workspace.cwd, context);
      }

      if (service.volumes)
        service.volumes = service.volumes.map((volume: any) => {
          if (typeof volume === "string" && (volume.startsWith("./") || volume.startsWith("../")))
            return join(base, volume);

          if (volume?.type === "bind" && volume.source && !isAbsolute(volume.source))
            return { ...volume, source: resolve(base, volume.source) };

          return volume;
        });
    }

    manifests[index] = { config, arguments: options.command };
  }

  return {
    manifests,
    sources: [...sources.values()].map(({ path, sha256 }) => ({ path, sha256 })),
  };
}
