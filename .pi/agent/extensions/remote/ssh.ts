import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTarget } from "../shared/contracts/remote.ts";

export function sshOptions(target: Pick<RemoteTarget, "user" | "host">) {
  return [
    "-F",
    "/dev/null",
    ...[
      "BatchMode=yes",
      "PreferredAuthentications=publickey",
      "PubkeyAuthentication=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "GSSAPIAuthentication=no",
      "HostbasedAuthentication=no",
      "IdentityFile=none",
      "IdentityAgent=/ssh-agent",
      "AddKeysToAgent=no",
      "ForwardAgent=no",
      "ForwardX11=no",
      "PermitLocalCommand=no",
      "ProxyCommand=none",
      "ProxyJump=none",
      "RemoteCommand=none",
      "EscapeChar=none",
      "StrictHostKeyChecking=yes",
      "UserKnownHostsFile=/known_hosts",
      "GlobalKnownHostsFile=/dev/null",
      "ConnectTimeout=10",
      "ConnectionAttempts=1",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=2",
      "ControlMaster=no",
      "ControlPath=none",
      "LogLevel=ERROR",
    ].flatMap((option) => ["-o", option]),
    "-T",
    `${target.user}@${target.host}`,
  ];
}

const FORWARD_SUPERVISOR = `import json,selectors,subprocess,sys
argv=json.loads(sys.argv[1])
result=subprocess.run(argv,stdout=subprocess.DEVNULL)
if result.returncode: sys.exit(result.returncode)
print("PI_SSH_FORWARD_READY",flush=True)
selector=selectors.DefaultSelector()
selector.register(sys.stdin,selectors.EVENT_READ)
while True:
    if selector.select(1):
        if not sys.stdin.buffer.read(1): break
    status=subprocess.run([argv[0],"-F","/dev/null","-S","/tmp/pi-master","-O","check",sys.argv[2]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if status.returncode: sys.exit(1)
`;

/** Only a fixed native SSH client sees the agent socket; neither remote commands nor model shells do. */
export async function sshProcess(
  target: RemoteTarget,
  extra: string[],
  command?: string,
  forward = false,
) {
  const socket = process.env.SSH_AUTH_SOCK;
  const bwrap = Bun.which("bwrap"),
    ssh = Bun.which("ssh");

  if (!socket || !(await lstat(socket)).isSocket())
    throw new Error("SSH_AUTH_SOCK must name an available local SSH agent socket");

  if (process.platform !== "linux" || !bwrap?.startsWith("/usr/") || !ssh?.startsWith("/usr/"))
    throw new Error(
      "The SSH transport needs native Linux bwrap and OpenSSH; run Pi inside Lubox on macOS",
    );

  const directory = await mkdtemp(join(tmpdir(), "pi-remote-ssh-"));
  const known = join(directory, "known_hosts");

  await writeFile(known, target.knownHosts, { mode: 0o600 });

  const args = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind-try",
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--ro-bind-try",
    "/etc/passwd",
    "/etc/passwd",
    "--ro-bind-try",
    "/etc/group",
    "/etc/group",
    "--ro-bind-try",
    "/etc/hosts",
    "/etc/hosts",
    "--ro-bind-try",
    "/etc/nsswitch.conf",
    "/etc/nsswitch.conf",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--ro-bind",
    socket,
    "/ssh-agent",
    "--ro-bind",
    known,
    "/known_hosts",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp/home",
    "--setenv",
    "LANG",
    "C.UTF-8",
    ...(forward
      ? [
          "/usr/bin/python3",
          "-I",
          "-B",
          "-c",
          FORWARD_SUPERVISOR,
          JSON.stringify([ssh, ...extra, ...sshOptions(target)]),
          `${target.user}@${target.host}`,
        ]
      : [ssh, ...extra, ...sshOptions(target), ...(command ? [command] : [])]),
  ];
  let child: ChildProcessWithoutNullStreams;

  try {
    child = spawn(bwrap, args, {
      stdio: "pipe",
      detached: true,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });

    throw error;
  }

  const cleanup = () => rm(directory, { recursive: true, force: true });

  child.once("close", () => {
    void cleanup();
  });
  child.once("error", () => {
    void cleanup();
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  return child;
}

export function killSsh(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode != null || child.signalCode != null) return;

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export { knownHostKeys, acceptCipHostKey } from "./host-keys.ts";
