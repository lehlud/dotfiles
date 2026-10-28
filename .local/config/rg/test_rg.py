#!/usr/bin/env python3
"""CLI regressions; optional differential checks use an existing native ripgrep."""

import itertools
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'bin' / 'rg'
BASH = shutil.which('bash')
REFERENCE = os.environ.get('REAL_RG') or shutil.which('rg')
if REFERENCE and Path(REFERENCE).resolve() == SCRIPT:
    REFERENCE = None


class RipgrepTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='rg-bash-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.put('sample.txt', 'alpha beta\nBeta alpha\nthird\n\nalpha beta alpha\nlast\n')
        self.put('empty.txt', '')
        self.put('other.txt', 'other\n')
        self.put('literal.txt', '[a].* +? (x) {y} ^$ \\ end\n')
        self.put('unicode.txt', 'Grüße an München\n')
        self.put('tree/.git/config', 'needle\n')
        self.put('tree/.gitignore', 'ignored/\n*.log\n!keep.log\n/root.txt\n')
        self.put('tree/a.txt', 'needle\n')
        self.put('tree/.hidden.txt', 'needle\n')
        self.put('tree/ignored/x.txt', 'needle\n')
        self.put('tree/drop.log', 'needle\n')
        self.put('tree/keep.log', 'needle\n')
        self.put('tree/root.txt', 'needle\n')
        self.put('tree/src/root.txt', 'needle\n')
        self.put('tree/src/app.py', 'needle\n')
        self.put('tree/src/app.ts', 'needle\n')
        self.put('tree/src/.ignore', 'local.txt\n')
        self.put('tree/src/local.txt', 'needle\n')

    def put(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def run_rg(self, *args, data=None, executable=None, env=None):
        return subprocess.run(
            [executable or str(SCRIPT), *args],
            cwd=self.root,
            input=data,
            stdin=subprocess.DEVNULL if data is None else None,
            capture_output=True,
            env=env,
            timeout=10,
        )

    def check(self, args, output, status=0, data=None):
        result = self.run_rg(*args, data=data)
        self.assertEqual(result.stderr, b'', args)
        self.assertEqual((result.returncode, result.stdout), (status, output), args)

    def test_regular_files_and_stdin(self):
        self.check(['-n', 'alpha', 'sample.txt'], b'1:alpha beta\n2:Beta alpha\n5:alpha beta alpha\n')
        self.check(['alpha'], b'alpha\n', data=b'alpha\nother\n')
        self.check(['-Hn', 'alpha', '-'], b'<stdin>:1:alpha\n', data=b'alpha\n')
        self.check(['-n', '^$', 'empty.txt'], b'', 1)
        self.check(['-n', '^$', '-'], b'1:\n', data=b'\n')
        self.check(['-n', '^$', '-'], b'1:\n2:\n', data=b'\n\n')
        self.check(['last', '-'], b'last\n', data=b'last')
        self.check(['anything', '-'], b'', 1, data=b'')

    def test_quiet_stdin_does_not_wait_for_eof(self):
        process = subprocess.Popen(
            [str(SCRIPT), '-q', 'needle', '-'], cwd=self.root,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            process.stdin.write(b'needle\n')
            process.stdin.flush()
            self.assertEqual(process.wait(timeout=3), 0)
            self.assertEqual(process.stdout.read(), b'')
            self.assertEqual(process.stderr.read(), b'')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    def test_matching_modes(self):
        self.check(['-Fin', '[A].*', 'literal.txt'], b'1:[a].* +? (x) {y} ^$ \\ end\n')
        self.check(['-i', 'BETA', 'sample.txt'], b'alpha beta\nBeta alpha\nalpha beta alpha\n')
        self.check(['-S', 'Beta', 'sample.txt'], b'Beta alpha\n')
        self.check(['-S', 'beta', 'sample.txt'], b'alpha beta\nBeta alpha\nalpha beta alpha\n')
        self.check(['-x', 'third', 'sample.txt'], b'third\n')
        self.check(['-w', 'pha', 'sample.txt'], b'', 1)
        self.check(['-w', 'alpha', 'sample.txt'], b'alpha beta\nBeta alpha\nalpha beta alpha\n')
        self.check(['-o', 'alpha', 'sample.txt'], b'alpha\nalpha\nalpha\nalpha\n')
        self.check(['-o', '^alpha', 'sample.txt'], b'alpha\nalpha\n')
        self.check(['-no', '^$', 'sample.txt'], b'4:\n')
        self.check(['-o', 'a*', '-'], b'aa\n\n\n', data=b'aa x\n')
        self.check(['--column', 'alpha$', 'sample.txt'], b'2:6:Beta alpha\n5:12:alpha beta alpha\n')
        self.check(['-n', r'\[a\]', 'literal.txt'], b'1:[a].* +? (x) {y} ^$ \\ end\n')
        self.check(['-n', r'\w+\s+\d+', '-'], b'1:item 42\n', data=b'item 42\n')
        self.check(['München', 'unicode.txt'], 'Grüße an München\n'.encode())
        self.check(['--column', 'München', 'unicode.txt'], '1:12:Grüße an München\n'.encode())

    def test_context_counts_and_quiet(self):
        self.check(['-nC1', 'third', 'sample.txt'], b'2-Beta alpha\n3:third\n4-\n')
        self.check(['-nB1', '-A1', '-m1', 'alpha', 'sample.txt'], b'1:alpha beta\n2-Beta alpha\n')
        self.check(['-nc', 'alpha', 'sample.txt'], b'3\n')
        self.check(['-Hc', 'alpha', 'sample.txt'], b'sample.txt:3\n')
        self.check(['-m0', 'alpha', 'sample.txt'], b'', 1)
        self.check(['-m0', '--files-without-match', 'alpha', 'empty.txt'], b'', 1)
        self.check(['-q', 'alpha', 'sample.txt'], b'')
        self.check(['-q', 'missing', 'sample.txt'], b'', 1)
        self.check(['--files-without-match', 'alpha', 'sample.txt'], b'', 1)
        self.check(['--files-without-match', 'alpha', 'empty.txt'], b'empty.txt\n')
        self.check(['--files-without-match', '-q', 'alpha', 'empty.txt'], b'')
        self.check(['-0l', 'alpha', 'sample.txt'], b'sample.txt\0')

    def test_patterns_and_arguments_are_data(self):
        self.put('patterns', 'third\nlast\n')
        self.put('none', '')
        self.check(['-f', 'patterns', 'sample.txt'], b'third\nlast\n')
        self.check(['-f', 'none', 'sample.txt'], b'', 1)
        self.check(['-vf', 'none', 'sample.txt'], (self.root / 'sample.txt').read_bytes())
        self.check(['-e', 'third', '-e', 'last', 'sample.txt'], b'third\nlast\n')
        self.put('-dash', '-needle\n')
        self.check(['--', '-needle', './-dash'], b'-needle\n')
        self.put('space name.txt', '$(printf exploited > PWNED)\n')
        self.check(['-F', '$(printf exploited > PWNED)', 'space name.txt'], b'$(printf exploited > PWNED)\n')
        self.assertFalse((self.root / 'PWNED').exists())

    def test_ignore_rules_globs_types_and_explicit_paths(self):
        listed = self.run_rg('--files', '--sort', 'path', 'tree')
        self.assertEqual(listed.returncode, 0)
        self.assertEqual(listed.stdout.splitlines(), [
            b'tree/a.txt', b'tree/keep.log', b'tree/src/app.py', b'tree/src/app.ts', b'tree/src/root.txt',
        ])
        self.check(['--files', '-g', '*.py', 'tree'], b'tree/src/app.py\n')
        self.check(['--files', '-g', '**/*.{py,ts}', 'tree'], b'tree/src/app.py\ntree/src/app.ts\n')
        self.check(['--files', '-g', 'src/*.txt', 'tree'], b'', 1)
        self.check(['--files', '-g', 'tree/src/*.txt', 'tree'], b'tree/src/local.txt\ntree/src/root.txt\n')
        self.check(['--files', '-g', 'drop.log', 'tree'], b'tree/drop.log\n')
        self.check(['--files', '-t', 'py', 'tree'], b'tree/src/app.py\n')
        self.check(['--files', '-Tpy', '-Tts', 'tree'], b'tree/a.txt\ntree/keep.log\ntree/src/root.txt\n')
        self.check(['needle', 'tree/ignored/x.txt'], b'needle\n')
        self.check(['--files', '--max-depth=0', 'tree'], b'', 1)
        self.check(['--files', '--max-depth=1', 'tree'], b'tree/a.txt\ntree/keep.log\n')
        self.check(['--files', 'tree/src'], b'tree/src/app.py\ntree/src/app.ts\ntree/src/root.txt\n')
        hidden = self.run_rg('--files', '--hidden', 'tree').stdout.splitlines()
        self.assertIn(b'tree/.hidden.txt', hidden)
        self.assertNotIn(b'tree/.git/config', hidden)
        unrestricted = self.run_rg('--files', '-uu', 'tree').stdout.splitlines()
        self.assertIn(b'tree/.git/config', unrestricted)
        self.assertIn(b'tree/ignored/x.txt', unrestricted)

    def test_symlinks_binary_and_exit_statuses(self):
        (self.root / 'binary').write_bytes(b'needle\0tail\n')
        self.check(['needle', 'binary'], b'', 1)
        (self.root / 'tree/link.txt').symlink_to('a.txt')
        self.assertNotIn(b'tree/link.txt', self.run_rg('--files', 'tree').stdout.splitlines())
        self.assertIn(b'tree/link.txt', self.run_rg('--files', '-L', 'tree').stdout.splitlines())
        (self.root / 'tree/loop').symlink_to('.')
        result = self.run_rg('--files', '-L', 'tree')
        self.assertEqual(result.returncode, 2)
        self.assertIn(b'filesystem loop', result.stderr)
        quiet = self.run_rg('-q', 'alpha', 'sample.txt', 'missing')
        self.assertEqual((quiet.returncode, quiet.stdout), (0, b''))
        self.assertEqual(self.run_rg('alpha', 'sample.txt', 'missing').returncode, 2)

    def test_errors_are_explicit(self):
        for args in [[], ['[', 'sample.txt'], ['--pcre2', 'a'], ['--json', 'a'],
                     ['--quiet=yes', 'a'], ['--color', 'always', 'a'], ['-e'],
                     ['--max-depth=-1', 'a'], ['-m', '99999999999999999', 'a'],
                     ['-t', 'not-a-type', 'a'], [r'\bword', 'sample.txt']]:
            with self.subTest(args=args):
                result = self.run_rg(*args)
                self.assertEqual(result.returncode, 2, result)
                self.assertIn(b'rg:', result.stderr)

    def test_literal_positions_and_word_boundaries(self):
        self.check(['-wo', 'cat', '-'], b'cat\ncat\n', data=b'cats cat _cat cat!\n')
        self.check(['--column', '-w', 'cat', '-'], b'1:6:cats cat _cat cat!\n',
                   data=b'cats cat _cat cat!\n')
        self.check(['-o', '-e', 'later', '-e', 'early', '-'], b'early\nlater\n',
                   data=b'early later\n')
        self.check(['-x', '-o', 'cat', '-'], b'cat\n', data=b'cats\ncat\ncat cat\n')
        self.check(['-io', 'cAt', '-'], b'CAT\ncat\n', data=b'CAT cat\n')
        self.check(['-Fo', '*?', '-'], b'*?\n*?\n', data=b'x*?y*?\n')
        self.check(['-Fox', '*?', '-'], b'*?\n', data=b'xxx\n*?\n*?*?\n')
        self.check(['--column', '-F', 'cat', '-'], '1:4:ä cat\n'.encode(), data='ä cat\n'.encode())

    def test_file_rejection_preserves_anchors_and_output_modes(self):
        self.put('anchored.txt', 'prefix\nneedle\nsuffix\n')
        for pattern in ['^needle', 'needle$', '^needle$', '^needle|missing$']:
            self.check(['-n', pattern, 'anchored.txt'], b'2:needle\n')

        self.check(['--files-without-match', 'missing', 'anchored.txt'], b'anchored.txt\n')
        self.check(['-vc', 'missing', 'anchored.txt'], b'3\n')
        self.check(['-vnC1', 'missing', 'anchored.txt'], b'1:prefix\n2:needle\n3:suffix\n')
        self.check(['[[:space:]]', 'anchored.txt'], b'', 1)
        self.check(['-F', '^needle$', 'anchored.txt'], b'', 1)
        self.check(['-Fi', 'NEEDLE', 'anchored.txt'], b'needle\n')
        self.check(['-F', '-e', 'missing', '-e', 'needle', 'anchored.txt'], b'needle\n')

        # Some Bash regex engines expose GNU buffer anchors through escaped punctuation.
        for pattern in [r"needle\'", r'\`needle']:
            probe = subprocess.run([BASH, '-c', '[[ needle =~ $1 ]]', 'bash', pattern])
            if probe.returncode == 0:
                self.check(['-n', pattern, 'anchored.txt'], b'2:needle\n')

    def test_binary_skip_still_applies_after_an_early_match(self):
        (self.root / 'late-binary').write_bytes(b'needle\n' + b'text\n' * 5000 + b'\0tail')
        self.check(['-q', 'needle', 'late-binary'], b'', 1)
        self.check(['-l', 'needle', 'late-binary'], b'', 1)

    def test_no_external_runtime_dependencies(self):
        environment = dict(os.environ, PATH='/nonexistent')
        environment.pop('BASH_ENV', None)
        result = subprocess.run(
            [BASH, str(SCRIPT), '-n', 'needle', 'tree'],
            cwd=self.root, env=environment, stdin=subprocess.DEVNULL,
            capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'tree/src/app.py:1:needle', result.stdout)
        self.assertEqual(result.stderr, b'')

    @unittest.skipUnless(REFERENCE, 'native ripgrep not installed')
    def test_native_ripgrep_compatibility(self):
        cases = [
            ['alpha', 'sample.txt'], ['-n', 'alpha', 'sample.txt'],
            ['-Fin', '[A].*', 'literal.txt'], ['-v', 'alpha', 'sample.txt'],
            ['-i', 'BETA', 'sample.txt'], ['-S', 'Beta', 'sample.txt'],
            ['-o', 'alpha', 'sample.txt'], ['-o', '^alpha', 'sample.txt'],
            ['-no', '^$', 'sample.txt'], ['-no', 'a*', 'sample.txt'],
            ['-x', 'third', 'sample.txt'], ['-w', 'alpha', 'sample.txt'],
            ['--column', 'alpha$', 'sample.txt'], ['-c', 'alpha', 'sample.txt'],
            ['--column', '-C1', 'alpha', 'sample.txt'],
            ['-v', '-o', 'alpha', 'sample.txt'],
            ['-m0', '--files-without-match', 'alpha', 'empty.txt'],
            ['-l', 'alpha', 'sample.txt', 'other.txt'], ['-nC1', 'third', 'sample.txt'],
            ['-m1', '-A1', 'alpha', 'sample.txt'], ['-n', '', 'sample.txt'],
            ['--files', '--sort', 'path', 'tree'], ['--files', '-g', '*.py', 'tree'],
            ['--files', '-g', '**/*.{py,ts}', 'tree'],
            ['--files', '--max-depth=1', 'tree'], ['--files', '-tpy', 'tree'],
            ['--files', '-g', 'drop.log', 'tree'], ['--files', 'tree/src'],
            ['--files', '-g', 'src/*.txt', 'tree'], ['--files', '-g', 'tree/src/**', 'tree'],
            ['--column', 'München', 'unicode.txt'],
            ['--sort', 'path', '-Hn', 'needle', 'tree'], ['-n', 'missing', 'sample.txt'],
        ]
        for args in cases:
            with self.subTest(args=args):
                expected = self.run_rg('--sort', 'path', *args, executable=REFERENCE)
                actual = self.run_rg('--sort', 'path', *args)
                self.assertEqual((actual.returncode, actual.stdout),
                                 (expected.returncode, expected.stdout))
                self.assertEqual(actual.stderr, b'')

    @unittest.skipUnless(REFERENCE, 'native ripgrep not installed')
    def test_native_multi_file_output_modes(self):
        patterns = ['alpha', 'beta', '[ab]', '^alpha', 'alpha$', '^$',
                    '[[:alpha:]]+', 'a{1,2}', '^alpha|last$']
        flags = [[], ['--column'], ['-o'], ['-w', '-o'], ['-v', '-c'],
                 ['--files-without-match'], ['-nC1'], ['--column', '-C1'],
                 ['-0', '-Hn'], ['-0', '-Hc'], ['-v', '-o'],
                 ['-m0', '--files-without-match']]

        for pattern, options in itertools.product(patterns, flags):
            args = ['--sort', 'path', *options, pattern, 'sample.txt', 'other.txt', 'empty.txt']
            with self.subTest(args=args):
                expected = self.run_rg(*args, executable=REFERENCE)
                actual = self.run_rg(*args)
                self.assertEqual((actual.returncode, actual.stdout, actual.stderr),
                                 (expected.returncode, expected.stdout, expected.stderr))


if __name__ == '__main__':
    unittest.main(verbosity=2)
