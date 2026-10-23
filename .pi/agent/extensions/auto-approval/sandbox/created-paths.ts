import { spawn } from "node:child_process";
import { lstat, rmdir, unlink } from "node:fs/promises";
import type { Workspace } from "./types.ts";

const creator = `import json,os,stat,sys
created=[]
try:
    for entry in json.load(sys.stdin):
        parent=os.open(entry["parent"],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            info=os.fstat(parent)
            if (info.st_dev,info.st_ino)!=(int(entry["device"]),int(entry["inode"])):
                raise ValueError("Creation parent changed after review")
            name=os.path.basename(entry["path"])
            if entry["create"]=="directory":
                os.mkdir(name,mode=0o700,dir_fd=parent)
            else:
                descriptor=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
                os.close(descriptor)
            info=os.stat(name,dir_fd=parent,follow_symlinks=False)
            created.append({"path":entry["path"],"device":str(info.st_dev),"inode":str(info.st_ino)})
        finally:
            os.close(parent)
    print(json.dumps(created))
except Exception:
    for entry in reversed(created):
        info=os.lstat(entry["path"])
        if (info.st_dev,info.st_ino)==(int(entry["device"]),int(entry["inode"])):
            if stat.S_ISDIR(info.st_mode):
                os.rmdir(entry["path"])
            else:
                os.unlink(entry["path"])
    raise
`;

type Created = { path: string; device: string; inode: string };

/** Only approved creations run here. O_EXCL/dir_fd prevent overwriting aliases or a new occupant. */
export async function createGrantedPaths(workspace: Workspace): Promise<Created[]> {
  if (!workspace.pendingPaths?.length) return [];

  const child = spawn("/usr/bin/python3", ["-I", "-B", "-c", creator], {
    stdio: "pipe",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  let output = "",
    diagnostic = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);

  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    diagnostic = (diagnostic + data.toString()).slice(-2000);
  });
  child.stdin.on("error", () => {});

  const exited = new Promise<number | null>((done, reject) => {
    child.once("close", done);
    child.once("error", reject);
  });

  child.stdin.end(JSON.stringify(workspace.pendingPaths));

  try {
    if ((await exited) !== 0)
      throw new Error(`Approved path creation failed: ${JSON.stringify(diagnostic)}`);

    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
  }
}

export async function cleanEmptyCreatedPaths(created: Created[]) {
  for (const entry of [...created].reverse()) {
    const info = await lstat(entry.path, { bigint: true }).catch(() => undefined);

    if (!info || info.dev.toString() !== entry.device || info.ino.toString() !== entry.inode)
      continue;

    try {
      if (info.isDirectory()) await rmdir(entry.path);
      else if (info.isFile() && info.size === 0n && info.nlink === 1n) await unlink(entry.path);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
}
