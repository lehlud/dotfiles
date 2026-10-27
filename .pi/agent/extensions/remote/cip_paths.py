"""Explicit, reviewed grants within the two shared CIP mounts."""
import os


def grants(payload):
    requested = payload["request"].get("sandbox", {}).get("paths", [])
    if not requested:
        return []

    cip = payload.get("cip")
    if not cip:
        raise ValueError("Extra remote file grants require CIP mode")

    result = []
    for grant in requested:
        path = grant["path"]
        canonical = os.path.realpath(path)
        if canonical != path or not os.path.exists(path) or grant.get("create"):
            raise ValueError("Use an existing canonical CIP path; grant its parent to create files")

        if not any(path == root or path.startswith(root + "/") for root in [cip["home"], "/proj/ciptmp"]):
            raise ValueError("CIP path grants must stay within home or /proj/ciptmp")

        if grant["access"] not in ["read", "write"]:
            raise ValueError("Invalid CIP path access")

        result.append(grant)

    return result
