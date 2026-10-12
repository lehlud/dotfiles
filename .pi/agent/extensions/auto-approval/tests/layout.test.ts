import { expect, test } from "bun:test";
import * as prettier from "prettier";
import { groupCode, syntaxLeaves } from "../development/layout.ts";

test("completed control-flow, function and nested blocks always have a blank line", () => {
  const source = "function run() {\n  if (ok) {\n    work();\n  }\n  finish();\n}\nrun();\n";
  const grouped = groupCode(source);

  expect(grouped).toContain("  }\n\n  finish()");
  expect(grouped).toContain("}\n\nrun()");
  expect(groupCode("function outer() {\n  while (ok) {\n    work();\n  }\n}\n")).toContain(
    "  }\n\n}\n\n",
  );
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(source));
});

test("connected branches and do-while syntax remain attached", () => {
  const source =
    "try {\n  work();\n} catch (error) {\n  report(error);\n} finally {\n  cleanup();\n}\ndo {\n  work();\n} while (ok);\nfinish();\n";
  const grouped = groupCode(source);

  expect(grouped).toContain("} catch (error) {");
  expect(grouped).toContain("} finally {");
  expect(grouped).toContain("} while (ok);\n\nfinish()");
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(source));
});

test("setup, effects and exits form groups and leading comments stay with their statement", () => {
  const grouped = groupCode(
    "const a = 1;\nconst b = 2;\n// Execute together.\nwork(a);\nwork(b);\nreturn b;\n",
  );

  expect(grouped).toBe(
    "const a = 1;\nconst b = 2;\n\n// Execute together.\nwork(a);\nwork(b);\n\nreturn b;\n",
  );
});

test("callbacks, methods and class endings separate completed bodies", () => {
  const source =
    "class Team {\n  first() {\n    work();\n  }\n  second() {\n    work();\n  }\n}\nconst hooks = {\n  start: () => {\n    work();\n  },\n  stop: () => cleanup(),\n};\n";
  const grouped = groupCode(source);

  expect(grouped).toContain("  }\n\n  second()");
  expect(grouped).toContain("  },\n\n  stop:");
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(source));
});

test("prompt text, template expressions, regexes and comments retain their exact content", () => {
  const source =
    "const prompt = `if (ok) {\n}\n${(() => { return 1; })()}`;\nconst match = /[{}]/;\n/* }\nnext */\nwork(prompt);\n";
  const grouped = groupCode(source);

  expect(grouped).toContain("`if (ok) {\n}\n${(() => { return 1; })()}`");
  expect(grouped).toContain("/* }\nnext */");
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(source));
});

test("layout is idempotent after Prettier normalization", async () => {
  const source = "function outer(){while(ok){work();}}\nouter();";
  const once = groupCode(await prettier.format(source, { parser: "typescript" }));
  const twice = groupCode(await prettier.format(once, { parser: "typescript" }));

  expect(twice).toBe(once);
});

test("trailing comments stay attached to their completed block", () => {
  const source = "if (ok) {\n  work();\n} // End the check.\nfinish();\n";
  const grouped = groupCode(source);

  expect(grouped).toContain("} // End the check.\n\nfinish()");
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(source));
});

