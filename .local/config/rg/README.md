# Bash rg

`~/.local/bin/rg` implements common ripgrep commands using Bash builtins, indexed arrays,
pathname expansion and `[[ ... =~ ... ]]`. It does not invoke native ripgrep, grep, find,
Python, awk or sed. Searching never downloads or installs software.

```bash
rg -n 'TODO|FIXME' src
rg -F -e 'first literal' -e 'second literal' file.txt
rg --files -g '**/*.{ts,tsx}' src
rg --hidden -n -C 2 'pattern' .
rg -t py -l 'import asyncio' .
printf 'one\ntwo\n' | rg -n two
```

Run `rg --help` for supported flags. Unknown flags return exit status 2. Put `--` before a
positional pattern starting with `-`, or supply that pattern with `-e`.

## Behavior

- Directories are searched recursively. Hidden paths and symlinks are skipped by default.
  `--hidden` includes hidden paths; `-L` follows symlinks and reports directory loops.
- `.gitignore`, `.ignore` and `.rgignore` are read from ancestor directories and the search
  tree, in that order at each directory. Rules support comments, `!` negation, leading `/`,
  directory suffixes, component globs and `**`. An excluded directory is pruned; reinclude
  its parent before attempting to reinclude a descendant. Explicit file arguments bypass
  filters. Matching positive `-g` rules override ignore rules for files.
- Globs support `*`, `?`, bracket classes, `**` path components and flat `{a,b}` alternatives.
  Slash-containing command-line globs are relative to the current directory.
  File types: `c`, `cpp`, `css`, `dart`, `go`, `html`, `java`, `js`, `json`, `md`, `py`, `rust`,
  `sh`, `sql`, `toml`, `ts`, `txt`, `xml`, `yaml`, `zig`.
- `-u` disables ignore rules. `-uu` also includes hidden paths and `.git` directories.
- Stdin is streamed as text. With no paths, piped or redirected text is searched; otherwise
  the current directory is searched. `--files` always lists filesystem paths.
- Output is plain text, without headings or color. `--column` reports byte columns.
  `-0` terminates filenames with NUL for filename-listing and prefixed search output.
- Exit statuses are 0 for a match/selected filename, 1 for none and 2 for errors. A quiet
  search that finds a match returns 0 even if another path produced an error.

## Compatibility limits

The regex engine is Bash's POSIX extended regular expression engine. Alternation uses
leftmost-longest matching; Unicode behavior depends on the platform and locale. Convenience
escapes `\d`, `\D`, `\w`, `\W`, `\s`, `\S`, `\t` and `\r` are translated outside bracket
classes. Use POSIX classes inside brackets, and `-w` for word boundaries.

PCRE2, lookaround, noncapturing groups, lazy quantifiers, Unicode property escapes, multiline
search, replacement, JSON output, encodings, compressed files and custom type definitions
are outside this implementation's scope. `-o` cannot be combined with context flags.

Ignore processing applies `.gitignore` even outside Git repositories. Global Git excludes,
`.git/info/exclude`, ignore-file whitespace escaping and every Git wildmatch detail are not
implemented. Positive globs can select hidden paths directly; unmatched hidden parent
folders still require `--hidden` for traversal.

`RIPGREP_CONFIG_PATH` is not loaded. Numeric option values are limited to nine decimal digits.

Bash cannot store NUL bytes. Regular files containing NUL are skipped entirely, including
matches before the NUL. Stdin must contain text; Bash strips NUL bytes while reading it.
Regular files are read one at a time into memory. Large files, large trees and match-by-match
output can be considerably slower than native ripgrep. `--sort path` uses Bash string ordering
within each search root; explicit path arguments keep their command-line order.

The script uses Bash 3.2-era features. Validation currently runs on Linux with Bash 5.3;
macOS's bundled Bash has not been tested here.

## Validation

```bash
bash -n ~/.local/bin/rg
python3 ~/.local/config/rg/test_rg.py
```

The tests cover stdin, context, matching modes, paths with spaces, literal shell syntax,
ignore precedence, types, NUL output, binary files, symlinks and errors. A test runs Bash
with an empty executable search path to catch external helper dependencies. When native
ripgrep is available, differential cases compare stdout and exit status; set `REAL_RG` to
its absolute path if this launcher already takes precedence in `PATH`.
