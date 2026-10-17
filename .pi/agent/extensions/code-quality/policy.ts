export const CODE_POLICY_TYPE = "code-quality-instruction";

export const CODE_POLICY = `Code readability is a standing requirement for every task, language and agent, including generated
source and code shown in replies. Apply it when creating code and when editing existing code.
Explicit operator instructions take precedence; respect repository conventions without copying
accidental dense formatting.

Write for a human maintainer:

- Group statements by purpose, separated by one blank line. Keep related setup together;
  separate validation, request construction, I/O, error handling, decoding and result
  validation. Separate setup from effects and effects from a final return. A function must not
  be one uninterrupted wall of instructions.

- Always put a blank line after a completed control-flow block: if/else, loops, switch and
  try/catch/finally, including nested control flow. Keep syntactically connected else, catch,
  finally and do/while clauses attached; add the blank line after the complete construct.
  Consecutive closing braces and other enclosing closing delimiters stay together: do not
  insert a blank line between them, even when the inner brace closes control flow. Add the
  separating blank line when another statement follows the completed construct.
  Use equivalent spacing after dedented control flow in languages without braces.
  This is not a blanket closing-brace rule. Do not add blank lines just because a callback,
  closure, constructor argument, object/map literal, collection or JSON structure closes.
  Keep Flutter widget/route arguments and callback properties compact according to their
  normal formatter, including adjacent closing delimiters. Separate standalone functions and
  methods by semantic grouping where useful; a function's closing brace alone does not require
  a blank line before an enclosing delimiter or at end of file.

- Use braced, multiline control-flow bodies where the language supports them, including guards
  that throw or return. Avoid one-line if/loop bodies, multiple statements on one line, and
  compressed functions.

- Aim for lines around 80 columns and use 100 columns as the default upper bound when the
  operator or repository does not specify another width. Wrap long parameter lists, calls, maps,
  collections, conditionals and exception construction at natural syntax boundaries. Use
  descriptive intermediate values when they explain a long expression. An exact literal, URL or
  protocol payload must retain its contents; do not corrupt data to satisfy a line-width target.

- Give names their domain meaning. Keep functions focused and control flow easy to follow.
  Prefer explicit error paths to nested ternaries or clever expressions. Comments explain intent
  or constraints, not each obvious statement. Comments, documentation and programmed messages
  use English unless the operator explicitly requests another language.

- Preserve behavior, public APIs, wire formats, string contents and unrelated code. Formatting
  does not authorize a refactor or extra changes. Treat intentionally minified assets and
  byte-exact generated artifacts as explicit exceptions, not a style for maintained source.

Before reporting code work complete, run the appropriate existing formatter through the normal
approved action path when available, then inspect the resulting source/diff. Formatters do not
reliably add semantic groups or preserve required control-flow spacing: check those explicitly after
formatting and correct the final code. Confirm useful line wrapping, readable groups, required block
spacing and the absence of dense one-line guards. If no formatter is available, apply the rules
manually and verify them in the resulting source. Do not invent successful verification or add
formatting-only test suites to the user's project.

These are working-model instructions, not action approval or a completion verdict. Every external
operation still requires its normal review and sandbox. Reply in the language of the latest actual
operator message.`;
