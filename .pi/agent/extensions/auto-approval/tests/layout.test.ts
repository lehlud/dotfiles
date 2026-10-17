import { expect, test } from "bun:test";
import * as prettier from "prettier";
import { groupCode, syntaxLeaves } from "../development/layout.ts";

test("completed control flow gets a blank line and declarations keep semantic separation", () => {
  const source = "function run() {\n  if (ok) {\n    work();\n  }\n  finish();\n}\nrun();\n";
  const grouped = groupCode(source);

  expect(grouped).toContain("  }\n\n  finish()");
  expect(grouped).toContain("}\n\nrun()");
  expect(groupCode("function outer() {\n  while (ok) {\n    work();\n  }\n}\n")).toContain(
    "  }\n}\n",
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

test("callback properties, methods and class endings do not force brace-only spacing", () => {
  const source =
    "class Team {\n  first() {\n    work();\n  }\n  second() {\n    work();\n  }\n}\nconst hooks = {\n  start: () => {\n    work();\n  },\n  stop: () => cleanup(),\n};\n";
  const grouped = groupCode(source);

  expect(grouped).toContain("  }\n  second()");
  expect(grouped).toContain("  }\n}\n\nconst hooks");
  expect(grouped).toContain("  },\n  stop:");
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(source));
});

test("route callbacks and nested constructor arguments keep ordinary formatter layout", async () => {
  const source = `function legacyRoute(legacyPath, canonicalPath) {
  return GoRoute({
    path: legacyPath,
    redirect: (context, state) => {
      return canonicalClientUri(state.uri).toString();
    },
    routes: [
      GoRoute({
        path: ":id",
        redirect: (context, state) => {
          return canonicalClientUri(state.uri).toString();
        },
      }),
    ],
  });
}
`;
  const formatted = await prettier.format(source, { parser: "typescript" });
  const grouped = groupCode(formatted);

  expect(grouped).toBe(formatted);
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(source));
});

test("data literals receive no extra brace spacing while control flow inside callbacks still does", () => {
  const data =
    'const config = {\n  route: {\n    path: "/",\n  },\n  items: [\n    {\n      id: 1,\n    },\n  ],\n};\n';

  expect(groupCode(data)).toBe(data);

  const callback =
    "use({\n  redirect: () => {\n    if (ready) {\n      update();\n    }\n    return target;\n  },\n});\n";
  const grouped = groupCode(callback);

  expect(grouped).toContain("    }\n\n    return target;");
  expect(grouped).toContain("  },\n});\n");
  expect(grouped).not.toContain("  },\n\n");
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(callback));
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

test("nested control-flow closers stay together before the next statement group", () => {
  const source = `function collect(view) {
  for (const deployment of view.deployments) {
    if (periodsOverlap(deployment)) {
      users.add(deployment.record.userId);
    }
  }
  return users;
}
`;
  const grouped = groupCode(source);

  expect(grouped).toContain("    }\n  }\n\n  return users;");
  expect(grouped).not.toContain("    }\n\n  }");
  expect(syntaxLeaves(grouped)).toEqual(syntaxLeaves(source));
});

test("control flow at callback boundaries does not separate enclosing delimiters", () => {
  const source = `use({
  run: () => {
    while (ready) {
      if (done) {
        break;
      }
    }
  },
});
`;

  expect(groupCode(source)).toBe(source);
  expect(groupCode("if (ready) {\n  work();\n}\nfinish();\n")).toContain("}\n\nfinish();");
});
