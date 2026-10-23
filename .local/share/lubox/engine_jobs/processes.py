"""Bounded native CLI IO; no shell or inherited operator API environment."""
import os
import pathlib
import selectors
import signal
import subprocess
import time


def capture(engine, arguments, environment, cwd, timeout=15, limit=2097152):
    child = subprocess.Popen(
        engine.argv(arguments), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
        cwd=cwd, start_new_session=True,
    )
    selector = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    selector.register(child.stdout, selectors.EVENT_READ, "stdout")
    selector.register(child.stderr, selectors.EVENT_READ, "stderr")
    deadline, size = time.monotonic() + timeout, 0
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise TimeoutError("Engine command deadline exceeded")
            for key, _events in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                size += len(chunk)
                if size > limit:
                    raise ValueError("Engine command output bound exceeded")
                buffers[key.data].extend(chunk)
        status = child.wait(timeout=max(0.01, deadline - time.monotonic()))
        return {
            "exitCode": status,
            **{name: value.decode("utf-8", "replace") for name, value in buffers.items()},
        }
    except BaseException:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait()
        raise
    finally:
        selector.close()
        child.stdout.close()
        child.stderr.close()


def clean_environment():
    home = str(pathlib.Path.home())
    return {
        "PATH": "/opt/homebrew/bin:/opt/podman/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": home, "LANG": "C.UTF-8", "TERM": "dumb", "NO_COLOR": "1",
        "DOCKER_CLI_HINTS": "false", "GIT_TERMINAL_PROMPT": "0",
        "PYTHONNOUSERSITE": "1", "PYTHONSAFEPATH": "1",
    }
