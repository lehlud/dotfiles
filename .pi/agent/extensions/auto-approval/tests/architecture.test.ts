import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
type Dependency = { source: string; target: string; runtime: boolean };

async function dependencies(): Promise<Dependency[]> {
  const edges: Dependency[] = [];
  for await (const name of new Bun.Glob("**/*.ts").scan(root)) {
    if (name.includes("node_modules/") || name.includes("/tests/")) continue;
    const file = ts.createSourceFile(
      name,
      await readFile(join(root, name), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
      const target = relative(root, resolve(root, dirname(name), specifier.text));
      const typeOnly = ts.isImportDeclaration(statement)
        ? statement.importClause?.isTypeOnly
        : statement.isTypeOnly;
      const named = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : statement.exportClause;
      const allTypeOnly =
        named &&
        (ts.isNamedImports(named) || ts.isNamedExports(named)) &&
        named.elements.every((item) => item.isTypeOnly);
      edges.push({ source: name, target, runtime: !(typeOnly || allTypeOnly) });
    }
  }
  return edges;
}

function boundaryViolations(edges: Dependency[]): string[] {
  const allowed: Record<string, string[]> = {
    shared: ["shared"],
    "auto-approval": ["auto-approval", "shared", "web-research", "public-writing"],
    conversations: ["conversations", "shared"],
    multiplex: ["multiplex", "shared"],
    "provider-recovery": ["provider-recovery", "shared"],
    "public-writing": ["public-writing"],
    "web-research": ["web-research", "shared"],
  };
  return edges
    .filter(({ source, target }) => {
      // Peer construction is the explicit composition root for gated worker sessions.
      if (source === "conversations/side-conversation.ts" && target === "public-writing/rules.ts")
        return false;
      if (
        source === "multiplex/peer.ts" &&
        [
          "auto-approval/index.ts",
          "public-writing/index.ts",
          "conversations/progress.ts",
          "conversations/steering.ts",
        ].includes(target)
      )
        return false;
      return !allowed[source.split("/")[0]]?.includes(target.split("/")[0]);
    })
    .map(({ source, target }) => `${source} -> ${target}`);
}

function cycles(edges: Dependency[]): string[] {
  const outgoing = new Map<string, string[]>();
  for (const { source, target, runtime } of edges) {
    if (!runtime) continue;
    outgoing.set(source, [...(outgoing.get(source) ?? []), target]);
  }
  const visited = new Set<string>();
  const found: string[] = [];
  function visit(source: string, stack: string[]) {
    if (stack.includes(source)) {
      found.push([...stack, source].join(" -> "));
      return;
    }
    if (visited.has(source)) return;
    visited.add(source);
    for (const target of outgoing.get(source) ?? []) visit(target, [...stack, source]);
  }
  for (const source of outgoing.keys()) visit(source, []);
  return found;
}

const graph = await dependencies();
test("shared infrastructure and feature boundaries have no reverse imports or runtime cycles", () => {
  expect(graph.length).toBeGreaterThan(100);
  expect(boundaryViolations(graph)).toEqual([]);
  expect(cycles(graph)).toEqual([]);
});

test("boundary checks reject feature leakage and actual cycles but allow typed contracts", () => {
  expect(
    boundaryViolations([
      { source: "shared/review/client.ts", target: "auto-approval/index.ts", runtime: true },
    ]),
  ).toHaveLength(1);
  expect(
    boundaryViolations([
      { source: "conversations/goals.ts", target: "auto-approval/review.ts", runtime: true },
    ]),
  ).toHaveLength(1);
  expect(
    cycles([
      { source: "a", target: "b", runtime: true },
      { source: "b", target: "a", runtime: true },
    ]),
  ).toHaveLength(1);
  expect(
    cycles([
      { source: "a", target: "b", runtime: true },
      { source: "b", target: "a", runtime: false },
    ]),
  ).toEqual([]);
});

test("the isolated executor cannot reach host approval, configuration loading or credential resolution", () => {
  const reachable = new Set<string>();
  function visit(source: string) {
    if (reachable.has(source)) return;
    reachable.add(source);
    for (const edge of graph.filter((edge) => edge.source === source && edge.runtime))
      visit(edge.target);
  }
  visit("auto-approval/runner.ts");
  expect(reachable.has("shared/configuration/credential-profile.ts")).toBe(true);
  expect(
    [...reachable].filter(
      (name) =>
        name.startsWith("shared/session/") ||
        name.startsWith("shared/providers/") ||
        name.startsWith("shared/review/") ||
        name === "shared/configuration/load.ts" ||
        [
          "auto-approval/index.ts",
          "auto-approval/credential-access.ts",
          "auto-approval/git-config.ts",
        ].includes(name),
    ),
  ).toEqual([]);
});

test("the frozen executor fingerprint and Docker build context cover every local runtime dependency", async () => {
  const bootstrap = await readFile(join(root, "auto-approval/bootstrap.ts"), "utf8");
  const docker = await readFile(join(root, "auto-approval/Dockerfile"), "utf8");
  const ignore = await readFile(join(root, ".dockerignore"), "utf8");
  const visited = new Set<string>();
  function visit(source: string) {
    if (visited.has(source)) return;
    visited.add(source);
    for (const edge of graph.filter((edge) => edge.source === source && edge.runtime))
      visit(edge.target);
  }
  visit("auto-approval/runner.ts");
  for (const name of visited) {
    expect(bootstrap).toContain(JSON.stringify(relative("auto-approval", name)));
    const folder = name.split("/")[0];
    expect(
      docker.includes(`COPY ${name} `) || docker.includes(`COPY ${folder} /extensions/${folder}`),
    ).toBe(true);
    expect(ignore).toContain(`!${name}`);
  }
});
