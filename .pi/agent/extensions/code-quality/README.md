# Pi Code Quality

This extension supplies a standing readability instruction to every working-model request. It is
loaded by the Pi launcher and by each Multiplex peer, independently of Auto-Approval and public-prose
review. Goals, continuation, steering and additional tool turns keep the same instruction.

The defaults require semantic groups separated by blank lines, multiline braced guards, blank lines
after completed control flow (`if`/`else`, loops, `switch`, `try`/`catch`), descriptive names, focused
functions and wrapped calls and collections. Connected `else`, `catch`, `finally` and `do`/`while`
clauses remain attached. Consecutive closing braces and enclosing closing delimiters stay together,
even when the inner brace closes control flow. Add the separating blank line before the next
statement instead. The brace rule does not apply to callback or closure endings, constructor
arguments, object/map literals, collections or JSON structures. Flutter widget/route arguments and
callback properties keep normal formatter layout without added gaps between properties or closing
delimiters. Standalone functions and methods use semantic separation where useful; their closing
braces alone do not require blank lines before enclosing delimiters or at end of file.
Line width targets 80 columns with a default upper bound of 100; explicit operator/repository widths
and exact literal contents are respected. Python and other languages without braces use equivalent
control-flow spacing. Maintained generated source follows the same rules; intentionally minified or
byte-exact artifacts are explicit exceptions.

Agents must use the appropriate existing formatter when available, then inspect the final code for
semantic groups and block spacing. A formatter alone is insufficient: Dart format, Prettier and
other formatters do not necessarily add or retain these blank lines. Formatting never changes wire
formats, strings, APIs or task scope. No extra formatting-only project tests are requested.

The context hook replaces only its own obsolete custom instructions and adds one current, hidden
instruction. It leaves actual user text, other policies, tools and the saved transcript unchanged.
It has no tools, file access, executor, reviewer calls, verdicts or permissions. This ensures policy
delivery; it does not prove that a model's output complies. Existing formatters and source inspection
remain the verification step.

Dependencies are linked to the pinned shared SDK by operator startup. Tests live in the shared
`../auto-approval` package. For architecture and development commands, see the
[architecture guide](../README.md).
