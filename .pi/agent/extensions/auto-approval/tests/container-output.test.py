"""Exercise real child pipes, never Docker/Podman or operator workloads."""
import importlib.util
import pathlib
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[5] / '.local/share/lubox/engine_jobs'
spec = importlib.util.spec_from_file_location('engine_jobs', SOURCE / '__init__.py', submodule_search_locations=[str(SOURCE)])
package = importlib.util.module_from_spec(spec)
sys.modules['engine_jobs'] = package
spec.loader.exec_module(package)
from engine_jobs.output import WorkloadOutput
from engine_jobs.processes import capture
from engine_jobs.runtime import Job
from engine_jobs.policy import prepare_job


class PythonEngine:
    def argv(self, arguments):
        return [sys.executable, '-I', '-B', '-c', arguments[0]]


class OutputTests(unittest.TestCase):
    def test_unicode_and_small_limits_remain_bounded(self):
        for limit in [0, 1, 64, 256, 1024]:
            for data in ['ä雪'.encode() * 1000, b'\xff' * 1000]:
                output = WorkloadOutput(limit)
                for offset in range(0, len(data), 7):
                    output.append(data[offset:offset + 7])
                text, details = output.finish()
                self.assertLessEqual(len(text.encode()), limit)
                self.assertTrue(details['truncated'])
                self.assertEqual(details['outputBytes'], len(data))

    def test_untruncated_utf8_survives_the_internal_head_tail_boundary(self):
        data = ('ä雪' * 60).encode()
        output = WorkloadOutput(len(data) + 150)
        output.append(data)
        text, details = output.finish()
        self.assertEqual(text.encode(), data)
        self.assertFalse(details['truncated'])

    def test_large_stdout_and_stderr_finish_and_retain_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / 'finished'
            script = ('import os,pathlib,sys; '
                      'os.write(1,b"HEAD"+b"x"*200000); os.write(2,b"y"*200000+b"TAIL"); '
                      f'pathlib.Path({str(marker)!r}).write_text("done"); sys.exit(7)')
            output = WorkloadOutput(4096)
            result = capture(PythonEngine(), [script], {}, directory, output=output)
            text, details = output.finish()
            self.assertEqual(marker.read_text(), 'done')
            self.assertEqual(result['exitCode'], 7)
            self.assertTrue(text.startswith('HEAD'))
            self.assertTrue(text.endswith('TAIL'))
            self.assertLessEqual(len(text.encode()), 4096)
            self.assertEqual(details['outputBytes'], 400008)

    def test_control_output_stays_strict_and_workload_deadline_still_kills(self):
        script = 'import os,time; os.write(1,b"x"*100000); time.sleep(2)'
        with self.assertRaisesRegex(ValueError, 'output bound'):
            capture(PythonEngine(), [script], {}, '/', limit=256)
        with self.assertRaises(TimeoutError):
            capture(PythonEngine(), [script], {}, '/', timeout=0.1, output=WorkloadOutput(256))

    def test_batch_budget_keeps_later_failure_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            job = object.__new__(Job)
            job.engine, job.cwd, job.environment = PythonEngine(), directory, {}
            job.request = {'job': 'synthetic-output'}
            job.deadline, job.output = time.monotonic() + 5, WorkloadOutput(512)
            job.results = []
            job.plan = {'workloadCount': 0, 'commands': [
                {'kind': 'metadata', 'argv': ['print("FIRST"+"x"*20000)']},
                {'kind': 'metadata', 'argv': ['import sys; print("LAST FAILURE"); sys.exit(9)']},
            ]}
            with patch('engine_jobs.runtime.cancellation_path', return_value=pathlib.Path(directory) / 'absent'):
                result = job.execute()
            self.assertTrue(result['isError'])
            self.assertEqual(result['details']['exitCode'], 9)
            self.assertTrue(result['details']['truncated'])
            text = result['content'][0]['text']
            self.assertIn('FIRST', text)
            self.assertIn('LAST FAILURE', text)
            self.assertLessEqual(len(text.encode()), 512)

    def test_no_interpolate_remains_a_config_only_flag(self):
        request = {'job': 'cc1db821-430f-4c13-b4bd-f7c927e31dcb',
                   'commands': [['compose', 'config', '--no-interpolate', '--quiet']],
                   'workspace': {'cwd': '/', 'bindings': [], 'masked': [], 'uid': 1000, 'gid': 1000},
                   'compose': {'0': {'arguments': ['config', '--no-interpolate', '--quiet'],
                                     'config': {'services': {'app': {'image': 'sdk:cached',
                                                                   'environment': {'VALUE': '${UNCHANGED}'}}}}}}}
        config = prepare_job(request)['commands'][0]['config']
        self.assertEqual(config['services']['app']['environment']['VALUE'], '${UNCHANGED}')
        request['compose']['0']['arguments'] = ['exec', '-T', 'app', 'program', '--no-interpolate']
        config = prepare_job(request)['commands'][0]['config']
        self.assertEqual(config['services']['app']['environment']['VALUE'], '$${UNCHANGED}')
        request['compose']['0']['arguments'] = ['up', '--no-interpolate', '-d']
        with self.assertRaises(ValueError):
            prepare_job(request)


if __name__ == '__main__':
    unittest.main()
