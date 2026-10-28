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

Whole-file rejection and block rejection use necessary-match checks. Binary detection
happens first. Original stdin is restored after regular-file searches, including when a
later `-` argument consumes it.

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

Measured on Linux/Bash 5.3 against `676f9e2`, using generated ASCII text and a 400-file tree:

| Workload | Before (ms) | After (ms) | Speedup |
|---|---:|---:|---:|
| absent literal | 241.8 | 129.2 | 1.87× |
| sparse literal | 1072.8 | 456.5 | 2.35× |
| dense literal | 446.1 | 393.3 | 1.13× |
| sparse regex | 1388.8 | 655.7 | 2.12× |
| word search | 2272.2 | 540.2 | 4.21× |
| long-line columns | 223.7 | 114.9 | 1.95× |
| only matching | 705.7 | 610.2 | 1.16× |
| file discovery | 105.8 | 105.3 | 1.00× |

Separate controls used one warmup and three samples, with identical output checks. Add
`--controls --samples 3` to the benchmark command and choose a separate output file:

| Control | Before (ms) | After (ms) | Speedup |
|---|---:|---:|---:|
| Unicode word | 1128.4 | 276.8 | 4.08× |
| mixed density | 451.2 | 388.1 | 1.16× |
| dense stdin | 388.4 | 386.3 | 1.01× |
| multiple literals | 1188.3 | 244.1 | 4.87× |

In the large sparse-file cases, sampled process high-water memory fell from about 38.5 MiB
to 19.9 MiB. Other search cases also used less sampled memory; file discovery was essentially
unchanged. These are local synthetic measurements. Memory observations are approximate and
cover the search process, not an aggregate process-tree quota.

## Validation

```bash
bash -n ~/.local/bin/rg
python3 ~/.local/config/rg/test_rg.py
```

The tests cover stdin, context, matching modes, paths with spaces, literal shell syntax,
ignore precedence, types, NUL output, binary files, symlinks, block boundaries, density
changes, locale restoration and the disabled-`mapfile` fallback. A test runs Bash
with an empty executable search path to catch external helper dependencies. When native
ripgrep is available, differential cases compare stdout and exit status; set `REAL_RG` to
its absolute path if this launcher already takes precedence in `PATH`.
