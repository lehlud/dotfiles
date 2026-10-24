import { createHash } from "node:crypto";
import type { Request } from "../shared/contracts/action.ts";
import type { Config } from "../shared/configuration/schemas.ts";
import type { Workspace } from "./isolation.ts";
import { executeIsolated } from "./isolation.ts";

const reader = `import base64,hashlib,json,os,stat,sys
settings=json.loads(base64.b64decode(sys.argv[2]))
answers=[]
for name in settings["names"]:
    try:
        path=os.path.realpath(os.path.join(settings["cwd"],name))
        if not any(path==root or path.startswith(root.rstrip("/")+"/") for root in settings["bindings"]):
            raise ValueError("Configuration read exceeds granted project paths")
        if any(path==root or path.startswith(root.rstrip("/")+"/") for root in settings["masked"]):
            raise ValueError("Protected operator files cannot be container inputs")
        descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(descriptor,"rb") as source:
            info=os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>262144:
                raise ValueError("Configuration must be a bounded, unaliased regular file")
            data=source.read(262145)
            if len(data)>262144: raise ValueError("Configuration grew beyond its input bound")
        offset=settings["offset"]
        answers.append({"path":path,"data":base64.b64encode(data[offset:offset+16384]).decode(),"size":len(data),"sha256":hashlib.sha256(data).hexdigest()})
    except FileNotFoundError:
        answers.append({"errorCode":"ENOENT"})
    except (PermissionError,ValueError) as error:
        answers.append({"errorCode":"CONFIG_SCOPE","message":str(error)})
print(json.dumps(answers))
`;

/** Fixed metadata inspection in a read-only projection; project code and private host files are absent. */
export function containerFileReader(workspace: Workspace, config: Config, signal?: AbortSignal) {
  return async (names: string[]) => {
    if (!names.length || names.length > 32)
      throw new Error("Configuration reader accepts one to 32 paths");

    const chunk = async (name: string, offset: number) => {
      const input = Buffer.from(
        JSON.stringify({
          names: [name],
          offset,
          cwd: workspace.cwd,
          bindings: workspace.bindings,
          masked: workspace.masked.map((entry) => entry.path),
        }),
      ).toString("base64");
      const source = Buffer.from(reader).toString("base64");
      const request: Request = {
        tool: "bash",
        arguments: {
          command: `python3 -I -B -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]))' ${source} ${input}`,
          timeout: 10,
        },
        goal: "Inspect declared container configuration without running project code",
        justification: "Trusted read-only executor preflight for the independent review plan",
        sandbox: {
          network: "none",
          limits: { executionTimeoutMs: 10000, maxOutputBytes: 8388608 },
        },
      };
      const result = await executeIsolated(
        request,
        { ...workspace, readOnlyBindings: workspace.bindings, cgroup: undefined },
        config.sandbox,
        signal,
      );

      if (result.isError)
        throw new Error(
          `Isolated container configuration inspection failed (executor exit ${result.details?.exitCode ?? "unknown"}); no configuration accepted`,
        );

      return JSON.parse(
        result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join(""),
      )[0];
    };
    const answers = [];

    for (const name of names) {
      const first = await chunk(name, 0);

      if (first.errorCode) {
        if (first.errorCode !== "ENOENT")
          throw new Error(`Container configuration inspection failed: ${first.message}`);

        answers.push(first);

        continue;
      }

      const buffers = [Buffer.from(first.data, "base64")];

      for (let offset = 16384; offset < first.size; offset += 16384) {
        const next = await chunk(name, offset);

        if (next.sha256 !== first.sha256 || next.path !== first.path || next.size !== first.size)
          throw new Error("Container configuration changed during inspection");

        buffers.push(Buffer.from(next.data, "base64"));
      }

      const data = Buffer.concat(buffers);

      if (
        data.length !== first.size ||
        createHash("sha256").update(data).digest("hex") !== first.sha256
      )
        throw new Error("Invalid container configuration snapshot");

      const source = new TextDecoder("utf-8", { fatal: true }).decode(data);

      answers.push({ path: first.path, source, sha256: first.sha256 });
    }

    return answers;
  };
}
