# Code quality

A standing hidden instruction reaches every working-model request, including peers, goals,
steering and continuation, independently of action/public-writing review.

- Separate semantic groups with blank lines; use descriptive names, focused functions and
  multiline braced guards. Wrap calls/collections: target 80 columns, default maximum 100.
- After completed control flow, separate the next statement. Keep attached else/catch/finally/
  do-while clauses and consecutive closing braces/delimiters together, even after nested flow.
- Callback/closure, constructor/argument, class, collection/map/JSON endings alone require no
  gap. Flutter properties/delimiters keep normal layout; separate standalone declarations by
  meaning, not merely their closing brace or EOF. Non-braced languages use equivalent spacing.
- Maintained generated code follows these rules; exact/minified artifacts are exceptions.
  Explicit user/repository styles win. Preserve literal contents, wire formats, APIs and scope.
- Use the existing formatter, then inspect grouping/spacing: formatters may omit/remove gaps.
  No extra formatting-only project tests.

The hook replaces only its own obsolete instruction, retaining user text, other policies,
tools and saved history. It has no tools, executor, file access, reviewer or permissions.
Delivery does not prove compliance; formatting/source inspection remains necessary.

Startup links the pinned SDK. Tests run in `../auto-approval`; see the
[architecture guide](../README.md). The instruction has a 1,500-character test budget;
keep explanations here, operational rules there.
