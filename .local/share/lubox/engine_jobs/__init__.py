"""Privileged engine jobs invoked only by Pi's fixed, reviewed Lubox channel."""
import hashlib
import json
import os
import pathlib
import sys
import uuid

PROTOCOL = "pi-engine-v1"


def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(65536), b""):
            value.update(block)

    return value.hexdigest()


def source_identity():
    package = pathlib.Path(__file__).resolve().parent
    files = [package.parents[2] / "bin" / "lubox", *sorted(package.glob("*.py"))]
    return {str(path): digest(path) for path in files}


def native_engine(engine_type, requested):
    engine = engine_type.select(None if requested == "auto" else requested)
    path = pathlib.Path(engine.path).resolve()
    metadata = path.stat()
    with path.open("rb") as source:
        signature = source.read(4)

    if signature not in [b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe"]:
        raise ValueError("The operator engine must be a native system executable")

    if metadata.st_mode & 0o022:
        raise ValueError("The operator engine must not be writable by other users")

    return engine, {"engine": engine.name, "executable": str(path), "sha256": digest(path)}


def main(engine_type):
    try:
        raw = sys.stdin.buffer.read(1048577)
        if len(raw) > 1048576:
            raise ValueError("Container job request exceeds 1 MiB")

        request = json.loads(raw)
        sources = source_identity()
        if request.get("sources") != sources:
            raise ValueError("Lubox engine helper changed; prepare a fresh independent review")

        engine, identity = native_engine(engine_type, request.get("engine", "auto"))
        if request.get("operation") == "cancel":
            if str(uuid.UUID(request["job"])) != request["job"] or request.get("expectedProgram") != identity:
                raise ValueError("Invalid cancellation identity")
            from .runtime import cancel_job
            value = cancel_job(engine, request)
            print(json.dumps({"protocol": PROTOCOL, "value": value}))
            return 0

        from .policy import prepare_job
        plan = prepare_job(request)
        if request.get("operation") == "plan":
            value = {"program": identity, "sources": sources, "jobPlan": plan}
        elif request.get("operation") == "execute":
            if request.get("expectedProgram") != identity or request.get("expectedPlan") != plan:
                raise ValueError("Engine program or reviewed plan changed; obtain a fresh review")
            from .runtime import execute_job
            value = execute_job(engine, request, plan)
        else:
            raise ValueError("Unknown engine operation")

        print(json.dumps({"protocol": PROTOCOL, "value": value}))
        return 0
    except Exception as error:
        print(json.dumps({"protocol": PROTOCOL, "error": str(error)[:1000]}))
        return 1
