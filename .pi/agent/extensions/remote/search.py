"""Bounded stdlib search, including hidden files; no remote tool downloads."""
from collections import deque
import fnmatch
import os
import re
from .files import scoped_path, text_result


def numbered_lines(path, budget):
    with open(path, encoding="utf-8", errors="replace") as file:
        number = 0
        while True:
            line = file.readline(budget + 1)
            if not line:
                return

            if len(line.encode()) > budget:
                raise ValueError("Search line exceeds output limit")

            number += 1
            yield number, line.rstrip("\n")


def matching_lines(path, expression, args, budget):
    context = max(0, int(args.get("context", 0)))
    before = deque(maxlen=context)
    remaining, matches, emitted = 0, 0, 0
    for number, line in numbered_lines(path, budget):
        if expression.search(line):
            matches += 1
            for previous_number, previous in before:
                if previous_number > emitted:
                    yield previous_number, previous, False

            yield number, line, True
            emitted, remaining = number, context
            if matches >= max(1, int(args.get("limit", 100))):
                return
        elif remaining:
            yield number, line, False
            emitted, remaining = number, remaining - 1

        before.append((number, line))


def search_tool(payload, args, grep):
    base = scoped_path(payload, args.get("path", "."))
    pattern = args.get("glob", "*") if grep else args["pattern"]
    expression = None
    if grep:
        source = re.escape(args["pattern"]) if args.get("literal") else args["pattern"]
        expression = re.compile(source, re.I if args.get("ignoreCase") else 0)

    files = [base] if os.path.isfile(base) else (
        os.path.join(directory, name)
        for directory, _dirs, names in os.walk(base, followlinks=False)
        for name in names
    )
    found, size, matches = [], 0, 0
    limit = max(1, int(args.get("limit", 100 if grep else 1000)))
    for count, path in enumerate(files, 1):
        if count > 100000:
            raise ValueError("Search exceeds file bound; narrow its path")

        relative = os.path.relpath(path, base) if os.path.isdir(base) else os.path.basename(path)
        matched_name = fnmatch.fnmatch(relative, pattern)
        if not (matched_name or fnmatch.fnmatch(os.path.basename(path), pattern)):
            continue

        try:
            scoped_path(payload, path)
        except ValueError:
            continue

        rows = [(0, relative, True)]
        if grep:
            rows = matching_lines(path, expression, args, payload["budget"])
        for number, line, matched in rows:
            row = "%s%s%s:%s" % (relative, ":" if matched else "-", number, line) if grep else line
            size += len(row.encode()) + 1
            if size > payload["budget"]:
                raise ValueError("Search exceeds output limit; narrow its scope")

            found.append(row)
            matches += int(matched)
            if matches >= limit:
                return text_result("\n".join(found))

    return text_result("\n".join(found))
