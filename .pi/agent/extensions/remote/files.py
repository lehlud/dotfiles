"""Workspace-scoped file operations; no SSH or credential access."""
import base64
import difflib
import mimetypes
import os
import stat
import tempfile


def scoped_path(payload, value):
    root, temporary = payload["root"], payload["temporary"]
    if value == "/tmp" or value.startswith("/tmp/"):
        value = temporary + value[4:]
    elif value.startswith("~/"):
        value = os.path.join(payload["cip"]["home"], value[2:]) if payload.get("cip") else os.path.expanduser(value)
    elif not os.path.isabs(value):
        value = os.path.join(root, value)

    path = os.path.realpath(value)
    allowed_paths = [root, temporary] + [grant["path"] for grant in payload.get("cipGrants", [])]
    if not any(path == allowed or path.startswith(allowed + "/") for allowed in allowed_paths):
        raise ValueError("File tools are scoped to the selected workspace and private /tmp")

    return path


def text_result(text, **extra):
    return {"content": [{"type": "text", "text": text}], **extra}


def edit_diff(old, new):
    """Pi's native diff renderer expects signed, numbered lines, not unified headers."""
    before, after = old.splitlines(), new.splitlines()
    width = len(str(max(len(before), len(after), 1)))
    rows, first = [], None
    groups = difflib.SequenceMatcher(None, before, after, autojunk=False).get_grouped_opcodes(4)
    for group in groups:
        if rows:
            rows.append(" " + " " * width + " ...")

        for tag, start, end, new_start, new_end in group:
            if tag != "equal" and first is None:
                first = new_start + 1

            if tag in ["equal", "delete", "replace"]:
                sign = " " if tag == "equal" else "-"
                rows.extend(sign + str(index + 1).rjust(width) + " " + before[index]
                            for index in range(start, end))

            if tag in ["insert", "replace"]:
                rows.extend("+" + str(index + 1).rjust(width) + " " + after[index]
                            for index in range(new_start, new_end))

    return {"diff": "\n".join(rows), "firstChangedLine": first or 1}


def read_tool(path, args, budget):
    mime = mimetypes.guess_type(path)[0]
    if mime in ["image/png", "image/jpeg", "image/gif", "image/webp"]:
        with open(path, "rb") as file:
            data = file.read(budget + 1)
        if len(data) > budget:
            raise ValueError("Image exceeds output limit")

        encoded = base64.b64encode(data).decode()
        return {"content": [{"type": "image", "mimeType": mime, "data": encoded}]}

    lines = []
    size = 0
    offset, limit = max(1, int(args.get("offset", 1))), max(1, int(args.get("limit", 2000)))
    with open(path, encoding="utf-8", errors="replace") as file:
        for number in range(1, offset + limit):
            line = file.readline(budget + 1)
            if not line:
                break
            if len(line.encode()) > budget:
                raise ValueError("Line exceeds output limit; use a bounded shell extraction")
            if number >= offset:
                lines.append(line)
                size += len(line.encode())
                if size > budget:
                    raise ValueError("Read exceeds output limit; request fewer lines")

    return text_result("".join(lines))


def write_tool(path, args, edit):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    old = ""
    if edit or os.path.exists(path):
        if os.path.getsize(path) > 16777216:
            raise ValueError("File exceeds editing limit")
        with open(path, encoding="utf-8", newline="") as file:
            old = file.read()

    content = args.get("content", "")
    if edit:
        replacements = []
        for change in args["edits"]:
            needle = change["oldText"]
            if not needle or old.count(needle) != 1:
                raise ValueError("Each edit must match exactly once in the original file")
            start = old.index(needle)
            replacements.append((start, start + len(needle), change["newText"]))

        replacements.sort()
        if any(left[1] > right[0] for left, right in zip(replacements, replacements[1:])):
            raise ValueError("Edits overlap")

        content = old
        for start, end, replacement in reversed(replacements):
            content = content[:start] + replacement + content[end:]

    handle, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".pi-remote-write-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(content)
        os.chmod(temporary, stat.S_IMODE(os.stat(path).st_mode) if os.path.exists(path) else 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

    description = ("Edited " if edit else "Wrote ") + path
    return text_result(description, details=edit_diff(old, content) if edit else {"written": True})
