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
- Ignore files are read from ancestors and the search tree. `.rgignore` overrides `.ignore`,
  which overrides Git rules, regardless of directory depth. Within each source type, deeper
  files and later rules win. Git rules stop at the nearest worktree boundary and apply only
  inside repositories; `.git/info/exclude` has lower priority than `.gitignore`. Linked
  worktrees support literal `gitdir` and `commondir` paths without executing Git or shell code.
- Ignore rules support comments, escaped leading `#`/`!`, `!` negation, leading `/`, directory
  suffixes, escaped trailing spaces, component globs and `**`. Excluded directories are
  pruned; reinclude the parent before a descendant. Explicit file arguments bypass filters.
  Matching positive `-g` rules override ignore rules for files.
- Globs support `*`, `?`, bracket classes, `**` path components and flat `{a,b}` alternatives.
  Slash-containing command-line globs are relative to the current directory.
  File types: `c`, `cpp`, `css`, `dart`, `go`, `html`, `java`, `js`, `json`, `md`, `py`, `rust`,
  `sh`, `sql`, `toml`, `ts`, `txt`, `xml`, `yaml`, `zig`.
- `-u` disables ignore rules. `-uu` also includes hidden paths and `.git` directories.
- `-c` counts matching lines; `-co` and `--count-matches` count nonoverlapping occurrences.
  `-m` limits selected lines, including when counting occurrences. With `-v`, counts refer
  to selected nonmatching lines.
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
are outside this implementation's scope. Line output with `-o` cannot use context flags.
Zero-width regex matches around multibyte text can differ from native ripgrep; a single
empty literal reports every byte position, including positions within UTF-8 characters.

Global Git excludes and user Git configuration are not loaded. Glob matching covers a
subset of Git wildmatch/ripgrep glob syntax; nested or escaped brace alternatives and other
complex escaping can differ. Positive globs can select hidden paths directly; unmatched
hidden parent folders still require `--hidden` for traversal.

`RIPGREP_CONFIG_PATH` is not loaded. Numeric option values are limited to nine decimal digits.

Bash cannot store NUL bytes. Regular files containing NUL are skipped entirely, including
matches before the NUL. Stdin must contain text; Bash strips NUL bytes while reading it.
Regular files are read one at a time into memory. Large files, large trees and match-by-match
output can be considerably slower than native ripgrep. `--sort path` uses Bash string ordering
within each search root; explicit path arguments keep their command-line order.

Bash 4+ can use its `mapfile` builtin for block scanning. Bash 3.2 and shells with that
builtin disabled retain the line reader. Validation runs on Linux with Bash 5.3, including
the disabled-builtin fallback; macOS's bundled Bash has not been tested here.

## Performance

Plain literal searches use Bash string matching. Case-sensitive literal scans switch to
byte processing only after both patterns and the complete input are checked for ASCII.
Other matching retains the original locale. Raw reads and final-newline removal operate on
bytes, and filters access buffers by variable name to avoid full-file argument copies.

For large, sparse regular files, a bounded `mapfile` reader skips 64-line blocks that cannot
contain a match. A small density sample selects this path; consecutive useful blocks switch
back to streaming when the file becomes dense. Skipped empty lines still count toward line
numbers. Context, inverted output and stdin keep their line readers.

Whole-file rejection and block rejection use necessary-match checks. Literal `-q`, `-l`
and filename-exclusion searches can use a proven buffer match without scanning its lines.
Binary detection happens first. Original stdin is restored after regular-file searches,
including when a later `-` argument consumes it.

Directory traversal resolves physical paths with builtin `cd`, avoiding a subprocess per
directory and preserving names ending in newlines. Ignore syntax is parsed once; scoped
rule lists are reused until a directory changes them. Matching checks higher-priority rules
first and skips filesystem probes for hidden entries that cannot be selected.

Compare two versions with the Python 3.9+ standard-library harness:

```bash
python3 ~/.local/config/rg/benchmark_rg.py \
  --baseline /path/to/previous-rg \
  --candidate ~/.local/bin/rg \
  --output /tmp/rg-bash-benchmark.json --rss
```

The harness freezes both scripts at equal-length paths. Every execution checks stdout,
stderr and exit status. It runs each workload sequentially, includes startup costs, shuffles
the version order and reports medians after one warmup and five timing samples. Optional
Linux process-memory checks run separately after all timings. They sample `/proc`'s
high-water counter every 5 ms and may miss a peak immediately before exit. Omit `--rss`
on other platforms.

Measurements from 2026-10-28 use Linux/Bash 5.3 and baseline `1e25e30`. All executions
include startup, check output/status/stderr, and run sequentially with one warmup and five
samples. The real workspace's complete NUL-delimited filename set also agrees with native
ripgrep, with a fresh native check between rounds to detect concurrent file changes.

| Workload | Before (ms) | After (ms) | Speedup |
|---|---:|---:|---:|
| `~/gitsetze`: `--files` (66 files) | 1265.7 | 63.6 | 19.91× |
| Generated tree: `--files` (400 files) | 107.4 | 44.5 | 2.41× |
| Literal `-l`, 40,000 lines | 126.1 | 27.9 | 4.53× |
| Literal `-q`, 40,000 lines | 139.2 | 28.3 | 4.92× |
| Literal filename exclusion, 40,000 lines | 129.8 | 28.2 | 4.61× |

The seven existing content-search guard medians changed by less than 2.2%. Separate sampled memory
checks showed no material change. These measurements describe this machine and these inputs;
native ripgrep took 7.4 ms for the real listing. The runtime still uses Bash builtins only.

Local raw samples, executable hashes and validation logs are in `/tmp/rg-bash-discovery/`;
`final.json` covers the real workspace/presence modes and `general.json` the generated guards.

## Validation

```bash
bash -n ~/.local/bin/rg
python3 ~/.local/config/rg/test_rg.py
```

The tests cover stdin, context, matching modes, paths with spaces, literal shell syntax,
ignore priority and repository boundaries, linked worktrees, literal Git metadata paths,
occurrence counts, types, NUL output, binary files, symlinks, block boundaries, density changes,
locale restoration, working-directory restoration and the disabled-`mapfile` fallback. A test runs Bash
with an empty executable search path to catch external helper dependencies. When native
ripgrep is available, differential cases compare stdout and exit status; set `REAL_RG` to
its absolute path if this launcher already takes precedence in `PATH`.
