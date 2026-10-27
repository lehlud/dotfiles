"""Bounded child IO and identity-checked cancellation."""
import json
import os
import selectors
import signal
import subprocess
import time
from .protocol import UUID


def start_time(pid):
    try:
        with open("/proc/%s/stat" % pid) as file:
            return file.read().rsplit(")", 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def cancel(base, identifier):
    if not UUID.fullmatch(identifier):
        raise ValueError("Invalid remote action identity")

    try:
        with open(base + "/jobs/" + identifier) as file:
            job = json.load(file)
    except FileNotFoundError:
        return {"cancelled": False, "reason": "No live receipt; inspect remote state"}

    if job.get("start") and start_time(job["pid"]) == job["start"]:
        try:
            os.killpg(job["pid"], signal.SIGKILL)
        except ProcessLookupError:
            pass

        return {"cancelled": True}

    return {"cancelled": False, "reason": "Process ended or identity changed; nothing killed"}


def launch(argv, env=None, cwd=None, receipt=None):
    child = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=cwd,
        env=env,
        start_new_session=receipt is not None,
    )
    if receipt:
        try:
            with open(receipt, "x") as file:
                json.dump({"pid": child.pid, "start": start_time(child.pid)}, file)
        except BaseException:
            kill_group(child.pid)
            child.wait()
            raise

    return child


def kill_group(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def collect(child, data, timeout, limit, group=False, guard=None):
    output = bytearray()
    selector = selectors.DefaultSelector()
    pending = memoryview(data)
    os.set_blocking(child.stdout.fileno(), False)
    selector.register(child.stdout, selectors.EVENT_READ)
    if pending:
        os.set_blocking(child.stdin.fileno(), False)
        selector.register(child.stdin, selectors.EVENT_WRITE)
    else:
        child.stdin.close()

    deadline = time.monotonic() + timeout
    next_guard = 0
    try:
        while selector.get_map():
            if guard and time.monotonic() >= next_guard:
                guard()
                next_guard = time.monotonic() + 2

            if time.monotonic() >= deadline:
                raise TimeoutError("Remote action deadline exceeded")

            for key, _events in selector.select(min(0.2, max(0, deadline - time.monotonic()))):
                if key.fileobj is child.stdin:
                    try:
                        pending = pending[os.write(child.stdin.fileno(), pending[:65536]):]
                    except BrokenPipeError:
                        pending = b""

                    if not pending:
                        selector.unregister(child.stdin)
                        child.stdin.close()

                    continue

                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue

                output.extend(chunk)
                if len(output) > limit:
                    raise ValueError("Remote action output limit exceeded")

        return child.wait(timeout=max(0.01, deadline - time.monotonic())), bytes(output)
    except BaseException as error:
        if group:
            if getattr(error, "graceful", False):
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                else:
                    # Do not reap the group leader yet: its PID stays reserved
                    # while descendants finish their checkpoint handlers.
                    time.sleep(2)

            kill_group(child.pid)
        else:
            child.kill()

        child.wait()
        raise
    finally:
        selector.close()
        child.stdout.close()
        child.stdin.close()
