export const CODE_POLICY_TYPE = "code-quality-instruction";

export const CODE_POLICY = `Code readability is a standing requirement for every language, agent and maintained generated source.
- Group statements by purpose with blank lines: setup, validation, I/O, errors, decoding, returns.
- Add a blank line after completed control flow before the next statement. Keep else/catch/finally/do-while attached. Consecutive closing braces/delimiters stay together, including after nested control flow. Callback, function, class, constructor, object/collection and JSON endings alone require no gap; use normal Flutter argument layout and semantic declaration spacing. Use equivalent dedent spacing without braces.
- Use braced, multiline control-flow bodies, including guards; no compressed functions or multiple statements per line. Use domain names and focused functions; comments explain intent.
- Target 80 columns, default maximum 100 columns; wrap calls and collections naturally. Preserve exact literals, wire formats, APIs and unrelated code. Minified/byte-exact artifacts are exceptions.
Explicit operator/repository style wins; programmed text, comments and docs default to English. Run the available formatter, then inspect grouping, wrapping and block spacing manually; report unavailable checks honestly. No extra formatting-only project tests. Style grants no refactor scope or approval bypass. Reply in the latest operator message's language.`;
