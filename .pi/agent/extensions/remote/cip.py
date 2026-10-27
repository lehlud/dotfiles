"""Fixed CIP observations and login protection, outside the workload sandbox."""
import os
import re
import subprocess
import time


class CipOccupied(Exception):
    graceful = True


def session_properties(identifier, timeout):
    result = subprocess.run(
        ["/usr/bin/loginctl", "show-session", identifier,
         "-p", "Remote", "-p", "Name", "-p", "Seat", "-p", "TTY", "-p", "Type"],
        capture_output=True, timeout=timeout,
    )
    if result.returncode:
        raise ValueError("Cannot inspect login session")

    return dict(
        line.split("=", 1) for line in result.stdout.decode().splitlines() if "=" in line
    )


def local_session(properties):
    terminal = properties.get("TTY", "")
    has_seat = (
        properties.get("Seat")
        or properties.get("Type") in ["x11", "wayland"]
        or terminal.startswith(("tty", "console", ":"))
    )
    return properties.get("Remote") == "no" and has_seat


def occupants():
    # logind identifies local seats. Fall back to local utmp terminals and,
    # if those observations fail too, conservatively count every utmp user.
    try:
        sessions = subprocess.run(
            ["/usr/bin/loginctl", "list-sessions", "--no-legend", "--no-pager"],
            capture_output=True, timeout=3,
        )
        if sessions.returncode == 0 and len(sessions.stdout) <= 16384:
            local = []
            deadline = time.monotonic() + 3
            for row in sessions.stdout.decode("utf-8", "replace").splitlines():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("Login observation deadline exceeded")

                properties = session_properties(row.split()[0], remaining)
                if local_session(properties):
                    local.append(properties.get("Name", "local user"))

            return sorted(set(local))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass

    return utmp_occupants()


def utmp_occupants():
    try:
        result = subprocess.run(["/usr/bin/who"], capture_output=True, timeout=3)
        if result.returncode == 0 and len(result.stdout) <= 16384:
            return sorted({
                fields[0] for row in result.stdout.decode("utf-8", "replace").splitlines()
                if len(fields := row.split()) >= 2 and not fields[1].startswith("pts/")
            })
    except (OSError, subprocess.TimeoutExpired):
        pass

    return all_utmp_users()


def all_utmp_users():
    try:
        result = subprocess.run(
            ["/usr/bin/users"], capture_output=True, timeout=3,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CipOccupied("Cannot verify local-user absence: %s" % error) from error

    if result.returncode or len(result.stdout) > 4096:
        raise CipOccupied("Cannot verify local-user absence")

    return sorted(set(result.stdout.decode("utf-8", "replace").split()))


def guard():
    users = occupants()
    if users:
        raise CipOccupied("Local session detected: " + ", ".join(users))


def status():
    home = os.path.realpath(os.path.expanduser("~"))
    quota = subprocess.run(
        ["cip-quota"], capture_output=True, timeout=10,
        env={
            "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
            "HOME": home, "NO_COLOR": "1", "TERM": "dumb",
        },
    )
    if quota.returncode or len(quota.stdout) > 65536:
        raise ValueError("cip-quota failed; storage-heavy work needs fresh quota evidence")

    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", quota.stdout.decode("utf-8", "replace"))
    rows = [
        {"usedMiB": int(used), "limitMiB": int(limit), "percent": int(percent), "path": path}
        for used, limit, percent, path in re.findall(
            r"(\d+) MiB of (\d+) MiB used \((\d+)%\) in ([^\r\n]+)", text,
        )
    ]
    if not os.path.isdir("/proj/ciptmp"):
        raise ValueError("The shared CIP temporary mount is unavailable")

    return {
        "occupants": occupants(), "home": home, "tmp": "/proj/ciptmp",
        "quota": rows, "quotaText": text,
    }


def interrupted(error):
    message = str(error) + ". Owned command stopped; inspect shared checkpoints before resuming."
    return {
        "content": [{"type": "text", "text": message}],
        "isError": True, "details": {"cipEvent": "occupied", "reason": str(error)},
    }
