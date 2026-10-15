import ts from "typescript";

function statementGroup(statement: ts.Statement): string {
  if (ts.isImportDeclaration(statement)) return "import";

  if (ts.isVariableStatement(statement)) return "setup";

  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return "exit";

  if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return "exit";

  if (
    ts.isIfStatement(statement) ||
    ts.isIterationStatement(statement, false) ||
    ts.isTryStatement(statement) ||
    ts.isSwitchStatement(statement)
  )
    return "flow";

  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  )
    return "declaration";

  return "effect";
}

/** Add spacing at syntax boundaries, never by matching braces inside source text. */
export function groupCode(source: string): string {
  const file = ts.createSourceFile("layout.ts", source, ts.ScriptTarget.Latest, true);
  const insertions = new Set<number>();

  function afterLine(position: number) {
    const end = source.indexOf("\n", position);

    if (end < 0) return;

    // A connected else/catch/finally/do-while or more code on this line stays attached.
    const suffix = source.slice(position, end).replace(/\/\/.*$|\/\*.*?\*\//g, "");

    if (!/^[\s),;\]]*$/.test(suffix)) return;

    if (source[end + 1] !== "\n") insertions.add(end + 1);

  }

  function beforeStatement(statement: ts.Statement) {
    const start = statement.getFullStart();
    const trivia = source.slice(start, statement.getStart(file));
    const first = start + (trivia.search(/\S/) < 0 ? trivia.length : trivia.search(/\S/));
    const line = source.lastIndexOf("\n", first - 1) + 1;

    if (line > 0 && source[line - 2] !== "\n") insertions.add(line);

  }

  function statements(items: ts.NodeArray<ts.Statement>) {
    for (let i = 1; i < items.length; i++) {
      const previous = items[i - 1];
      const current = items[i];

      if (
        file.getLineAndCharacterOfPosition(previous.end).line ===
        file.getLineAndCharacterOfPosition(current.getStart(file)).line
      )
        continue;

      if (
        statementGroup(previous) !== statementGroup(current) ||
        statementGroup(previous) === "flow" ||
        statementGroup(previous) === "declaration"
      ) {
        beforeStatement(current);
      }

    }

  }

  function visit(node: ts.Node) {
    if (
      ts.isSourceFile(node) ||
      ts.isBlock(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node)
    ) {
      statements(node.statements);
    }

    if (ts.isStatement(node) && statementGroup(node) === "flow") afterLine(node.end);

    ts.forEachChild(node, visit);
  }

  visit(file);

  let result = source;

  for (const position of [...insertions].sort((a, b) => b - a)) {
    result = result.slice(0, position) + "\n" + result.slice(position);
  }

  return result;
}

/** Leaf spelling includes literal contents as well as executable syntax. */
export function syntaxLeaves(source: string): string[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const leaves: string[] = [];

  function visit(node: ts.Node) {
    const children = node.getChildren(file);

    if (children.length) children.forEach(visit);
    else leaves.push(`${node.kind}:${node.getText(file)}`);

  }

  visit(file);

  return leaves;
}
