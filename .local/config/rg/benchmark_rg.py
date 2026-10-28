#!/usr/bin/env python3
"""Sequential, output-checked comparisons of frozen Bash rg executables."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import statistics
import subprocess
import sys
import tempfile
import time


def fixtures(root):
    line = 'const request = { path: "src/client.ts", version: 123, ready: true };\n'
    (root / 'sparse.txt').write_text((line * 999 + 'special_marker at offset 123\n') * 40)
    (root / 'absent.txt').write_text(line * 40000)
    (root / 'dense.txt').write_text('special_marker const request ready 123\n' * 10000)
    (root / 'long.txt').write_text(('x' * 4000 + ' special_marker\n') * 100)
    tree = root / 'tree'
    tree.mkdir()
    (tree / '.gitignore').write_text('skip/\n*.log\n')

    for i in range(20):
        directory = tree / str(i)
        directory.mkdir()
        for j in range(20):
            (directory / f'{j}.txt').write_text(line * 10)

    return [
        ('absent literal', ['special_marker', 'absent.txt']),
        ('sparse literal', ['-n', 'special_marker', 'sparse.txt']),
        ('dense literal', ['-n', 'special_marker', 'dense.txt']),
        ('sparse regex', ['-n', 'special_[a-z]+', 'sparse.txt']),
        ('word search', ['-w', 'special_marker', 'sparse.txt']),
        ('long-line columns', ['--column', 'special_marker', 'long.txt']),
        ('only matching', ['-o', 'special_marker', 'dense.txt']),
        ('file discovery', ['--files', 'tree']),
    ]


def control_fixtures(root):
    ordinary = 'const request = { path: "src/client.ts", ready: true };\n'
    (root / 'unicode.txt').write_text(
        ('Grüße aus München; Äpfel und Gemüse.\n' * 999 + 'special_marker gefunden\n') * 20)
    (root / 'mixed.txt').write_text(ordinary * 300 + 'special_marker dense row\n' * 10000)
    (root / 'dense.txt').write_text('special_marker dense row\n' * 10000)
    (root / 'sparse.txt').write_text((ordinary * 999 + 'special_marker\n') * 20)

    return [
        ('Unicode word', ['-wn', 'special_marker', 'unicode.txt'], None),
        ('mixed density', ['-n', 'special_marker', 'mixed.txt'], None),
        ('dense stdin', ['-n', 'special_marker', '-'], 'dense.txt'),
        ('multiple literals', ['-n', '-e', 'special_marker', '-e',
                               'unavailable_marker', 'sparse.txt'], None),
    ]


def invoke(executable, arguments, root, stdin_name=None):
    source = open(root / stdin_name, 'rb') if stdin_name else subprocess.DEVNULL
    started = time.perf_counter()

    try:
        result = subprocess.run(
            [str(executable), *arguments], cwd=root, stdin=source,
            capture_output=True, timeout=60,
        )
        elapsed = time.perf_counter() - started
    finally:
        if stdin_name:
            source.close()

    return (result.returncode, result.stdout, result.stderr), elapsed


def peak_rss(executable, arguments, root, stdin_name=None):
    """Sample Linux's post-exec VmHWM; wait4 can retain the spawn parent's peak."""
    peak_kib = 0
    started = time.monotonic()

    with (
        open(root / stdin_name if stdin_name else os.devnull, 'rb') as source,
        tempfile.TemporaryFile() as out,
        tempfile.TemporaryFile() as err,
    ):
        process = subprocess.Popen([str(executable), *arguments], cwd=root,
                                   stdin=source, stdout=out, stderr=err)
        try:
            while process.poll() is None:
                try:
                    status = Path(f'/proc/{process.pid}/status').read_text()
                    for line in status.splitlines():
                        if line.startswith('VmHWM:'):
                            peak_kib = max(peak_kib, int(line.split()[1]))
                except (FileNotFoundError, ProcessLookupError):
                    pass

                if time.monotonic() - started > 60:
                    raise TimeoutError('RSS run exceeded 60 seconds')
                time.sleep(0.005)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()

        out.seek(0)
        err.seek(0)
        result = (process.returncode, out.read(), err.read())

    if not peak_kib:
        raise RuntimeError('No RSS observation captured; no memory result is available')

    return result, peak_kib / 1024


def compare(args, root):
    binaries = {}
    identities = {}

    for name, source in [('baseline', args.baseline), ('candidate', args.candidate)]:
        target = root / ('base-rg' if name == 'baseline' else 'test-rg')
        shutil.copy2(source, target)
        binaries[name] = target
        identities[name] = hashlib.sha256(target.read_bytes()).hexdigest()

    rows = []
    references = []
    rng = random.Random(1729)
    cases = control_fixtures(root) if args.controls else [
        (name, arguments, None) for name, arguments in fixtures(root)]

    for name, arguments, stdin_name in cases:
        expected, _ = invoke(binaries['baseline'], arguments, root, stdin_name)
        assert expected[0] in (0, 1) and not expected[2], (name, expected)
        references.append(expected)
        samples = {'baseline': [], 'candidate': []}

        for round_number in range(args.warmups + args.samples):
            order = list(binaries)
            rng.shuffle(order)
            for choice in order:
                actual, elapsed = invoke(binaries[choice], arguments, root, stdin_name)
                assert actual == expected, f'{name}: {choice} changed exit status or output'
                if round_number >= args.warmups:
                    samples[choice].append(elapsed)

        medians = {choice: statistics.median(values) for choice, values in samples.items()}
        row = dict(name=name, arguments=arguments, stdin=stdin_name, seconds=samples, medians=medians,
                   speedup=medians['baseline'] / medians['candidate'],
                   output_sha256=hashlib.sha256(expected[1]).hexdigest(), status=expected[0])
        rows.append(row)
        print(f'{name}: {row["speedup"]:.2f}x ({medians["baseline"]:.3f}s -> {medians["candidate"]:.3f}s)', flush=True)

    # Memory observations are separate from every timing run.
    if args.rss:
        for row, expected in zip(rows, references):
            row['sampled_peak_rss_mib'] = {}
            for choice, executable in binaries.items():
                actual, rss = peak_rss(executable, row['arguments'], root, row['stdin'])
                assert actual == expected, f'{row["name"]}: RSS run changed output'
                row['sampled_peak_rss_mib'][choice] = rss

    return dict(binaries=identities, samples=args.samples, warmups=args.warmups,
                platform=sys.platform, controls=args.controls, rows=rows,
                memory_method='Linux VmHWM sampled every 5 ms' if args.rss else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--warmups', type=int, default=1)
    parser.add_argument('--controls', action='store_true',
                        help='test Unicode, changing density, stdin and multiple literals')
    parser.add_argument('--rss', action='store_true', help='separate Linux VmHWM observations sampled every 5 ms')
    args = parser.parse_args()

    if args.samples < 1 or args.warmups < 0:
        parser.error('samples must be positive; warmups must be nonnegative')

    if args.rss and not Path('/proc/self/status').exists():
        parser.error('--rss requires Linux /proc')

    args.baseline = args.baseline.resolve()
    args.candidate = args.candidate.resolve()
    with tempfile.TemporaryDirectory(prefix='rg-bash-benchmark-') as directory:
        report = compare(args, Path(directory))

    args.output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
