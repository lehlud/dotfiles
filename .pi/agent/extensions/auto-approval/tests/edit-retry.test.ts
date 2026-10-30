import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Check } from "typebox/value";
import { executeEdit } from "../edit-operation.ts";
import { expandEditRetry } from "../edit-retry.ts";
import { strictParameters } from "../tool-catalog.ts";

const original = {
  tool: "edit",
  arguments: {
    path: "example.py",
    edits: [
      {
        oldText: "url = raw[0]\nparsed = parse(url)",
        newText: "url = resolve(raw[0])\nparsed = parse(url)",
      },
      { oldText: "mode = 0", newText: "mode = 1" },
    ],
  },
  goal: "Fix URL handling",
  justification: "Retain official origin checks",
  sandbox: { paths: [{ path: "example.py", access: "write" }] },
};
const entries = [
  {
    type: "custom",
    customType: "auto-approval-review",
    data: { requestId: "source-review", decision: "approve", action: original },
  },
];
const retry = {
  tool: "edit",
  arguments: {
    retry: "source-review",
    edits: [{ index: 0, oldText: "url = raw[0]\n\nparsed = parse(url)" }],
  },
  goal: "Fix URL handling",
  justification: "Correct the stale anchor",
};

test("compact edit references expand text only, preserving the recorded action and fresh scope", () => {
  expect(Check(strictParameters, retry)).toBe(true);

  const expanded = expandEditRetry(retry, entries) as any;

  expect(Check(strictParameters, expanded)).toBe(true);
  expect(expanded.arguments.path).toBe(original.arguments.path);
  expect(expanded.arguments.edits[0].newText).toBe(original.arguments.edits[0].newText);
  expect(expanded.arguments.edits[0].oldText).toBe(retry.arguments.edits[0].oldText);
  expect(expanded.arguments.edits[1]).toEqual(original.arguments.edits[1]);
  expect(expanded.goal).toBe(retry.goal);
  expect(expanded.sandbox).toBeUndefined();
  expect(original.arguments.edits[0].oldText).not.toContain("\n\n");
});

test("references cannot use another branch, denied actions, model notes, or invalid indices", () => {
  expect(() => expandEditRetry(retry, [])).toThrow("Unknown approved edit");
  expect(() =>
    expandEditRetry(retry, [{ ...entries[0], data: { ...entries[0].data, decision: "deny" } }]),
  ).toThrow("Unknown approved edit");
  expect(() => expandEditRetry(retry, [{ ...entries[0], customType: "model-notes" }])).toThrow(
    "Unknown approved edit",
  );

  for (const edits of [
    [{ index: 3, oldText: "x" }],
    [
      { index: 0, oldText: "x" },
      { index: 0, oldText: "y" },
    ],
    [{ index: 0, oldText: "x", newText: "unsubmitted change" }],
  ]) {
    expect(() =>
      expandEditRetry({ ...retry, arguments: { ...retry.arguments, edits } }, entries),
    ).toThrow();
  }
});

test("a multi-edit conflict preserves the file, explains its current anchor and can reuse replacement text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-retry-"));

  try {
    const path = join(directory, "example.py");
    const before = "url = raw[0]\n\nparsed = parse(url)\nmode = 0\n";

    await writeFile(path, before);

    const failed = await executeEdit(directory, original.arguments);

    expect(failed.isError).toBe(true);
    expect(failed.details?.editConflict).toEqual({ index: 0, unchanged: true });
    expect(JSON.stringify(failed.content)).toContain("Nearby current lines");
    expect(JSON.stringify(failed.content)).not.toContain("sandbox failed");
    expect(await readFile(path, "utf8")).toBe(before);

    const expanded = expandEditRetry(retry, entries) as any;
    const result = await executeEdit(directory, expanded.arguments);

    expect(result.isError).not.toBe(true);
    expect(await readFile(path, "utf8")).toBe(
      "url = resolve(raw[0])\nparsed = parse(url)\nmode = 1\n",
    );
    expect(result.details?.diff).toContain("+1 url = resolve(raw[0])");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing later anchors and overlapping or ambiguous edits never apply a partial batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-atomic-"));

  try {
    const before = "alpha\nbeta\nalpha\n";

    await writeFile(join(directory, "file"), before);

    for (const edits of [
      [
        { oldText: "beta", newText: "changed" },
        { oldText: "missing", newText: "later" },
      ],
      [{ oldText: "alpha", newText: "ambiguous" }],
      [
        { oldText: "alpha\nbeta", newText: "x" },
        { oldText: "beta", newText: "y" },
      ],
    ]) {
      const result = await executeEdit(directory, { path: "file", edits });

      expect(result.isError).toBe(true);
      expect(result.details?.editConflict?.unchanged).toBe(true);
      expect(await readFile(join(directory, "file"), "utf8")).toBe(before);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
