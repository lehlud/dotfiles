"""Dispatch the reviewed tool and keep public Git settings scoped to one invocation."""
import json
import os
import re
import stat
from .files import scoped_path, text_result, read_tool, write_tool
from .processes import launch, collect
from .search import search_tool


def git_environment(payload, args):
    fixed = [
        "git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
        "-c", "core.fsmonitor=false", "-c", "diff.external=",
        "-c", "user.useConfigOnly=true", "-c", "core.pager=cat",
        "-c", "core.editor=false", "-c", "sequence.editor=false",
        "-c", "rebase.instructionFormat=%s", "-c", "rebase.updateRefs=false",
    ]
    os.environ.update({
        "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_PAGER": "cat", "GIT_SEQUENCE_EDITOR": "/usr/bin/false",
        "GIT_EDITOR": "/usr/bin/true" if "--continue" in args["argv"] else "/usr/bin/false",
    })
    public = None
    if payload.get("gitConfig"):
        public = os.path.join(payload["temporary"], ".public-git-" + payload["action"])
        with open(public, "x") as file:
            file.write(payload["gitConfig"])

        os.chmod(public, 0o400)
        os.environ["GIT_CONFIG_GLOBAL"] = public

    return fixed, public


def git_rebase_state(fixed, args, timeout, budget):
    """Reject persisted executable sequencer/config state, as in the local Git route."""
    if args["argv"][0] != "rebase":
        return

    def inspect(argv):
        status, output = collect(launch(fixed + argv), b"", timeout, budget)
        if status:
            raise ValueError("Cannot validate remote Git rebase state")

        return output.decode("utf-8")

    config = inspect(["config", "--null", "--list", "--includes"])
    for record in filter(None, config.split("\0")):
        key, _, value = record.partition("\n")
        if value and re.match(
            r"^(filter\..+\.(clean|smudge|process)|merge\..+\.driver|branch\..+\.mergeoptions)$",
            key, re.I,
        ):
            raise ValueError("Remote rebase with executable repository configuration is excluded")

        if value and re.match(r"^gpg(\..+)?\.program$", key, re.I):
            raise ValueError("Configured signing programs require a separate reviewed workflow")

    if "--abort" in args["argv"] or "--quit" in args["argv"]:
        return

    directory = inspect(["rev-parse", "--absolute-git-dir"]).rstrip("\n")
    for name in ["git-rebase-todo", "strategy"]:
        path = os.path.join(directory, "rebase-merge", name)
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            continue

        with os.fdopen(descriptor) as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise ValueError("Rebase state must be a regular file")

            value = file.read(1048577)
            if len(value) > 1048576:
                raise ValueError("Rebase state exceeds its bound")

        if name == "git-rebase-todo" and re.search(r"^\s*(exec|x)\s", value, re.M):
            raise ValueError("Pending rebase contains shell steps")

        strategies = ["ort", "recursive", "resolve", "octopus", "ours", "subtree", ""]
        if name == "strategy" and value.strip() not in strategies:
            raise ValueError("Pending rebase uses an external merge strategy")


def command_tool(payload, name, args):
    if payload.get("readOnly"):
        raise ValueError("Read-only remote delegation")

    argv = ["/bin/bash", "--noprofile", "--norc", "-c", args.get("command", "")]
    public = None
    try:
        if name == "powershell":
            argv = ["pwsh", "-NoProfile", "-NonInteractive", "-Command", args["command"]]

        if name == "git":
            fixed, public = git_environment(payload, args)
            git_rebase_state(fixed, args, payload["timeout"], payload["budget"])
            argv = fixed + args["argv"]

        timeout = min(payload["timeout"], args.get("timeout", payload["timeout"]))
        status, output = collect(launch(argv), b"", timeout, payload["budget"])
        return text_result(
            output.decode("utf-8", "replace"),
            isError=status != 0, details={"exitCode": status},
        )
    finally:
        if public:
            os.unlink(public)


def tool(payload):
    request, budget = payload["request"], payload["budget"]
    name, args = request["tool"], request["arguments"]
    path = scoped_path(payload, args.get("path", "."))
    if name == "read":
        answer = read_tool(path, args, budget)
    elif name in ["edit", "write"]:
        if payload.get("readOnly"):
            raise ValueError("Read-only remote delegation")

        answer = write_tool(path, args, name == "edit")
    elif name == "ls":
        names = sorted(os.scandir(path), key=lambda item: item.name)
        rows = [
            item.name + (
                "/" if item.is_dir(follow_symlinks=False) else "@" if item.is_symlink() else ""
            )
            for item in names[:max(1, int(args.get("limit", 500)))]]
        answer = text_result("\n".join(rows))
    elif name in ["find", "grep"]:
        answer = search_tool(payload, args, name == "grep")
    elif name in ["bash", "powershell", "git"]:
        answer = command_tool(payload, name, args)
    else:
        raise ValueError("Unsupported remote tool")

    if len(json.dumps(answer, ensure_ascii=False).encode()) > budget * 6 + 4096:
        raise ValueError("Remote output limit exceeded")

    return answer
