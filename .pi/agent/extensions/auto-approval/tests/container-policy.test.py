"""Guard regressions use fake engines only; no operator engine resources are touched."""
import copy
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[5] / '.local/share/lubox/engine_jobs'
spec = importlib.util.spec_from_file_location('engine_jobs', SOURCE / '__init__.py', submodule_search_locations=[str(SOURCE)])
package = importlib.util.module_from_spec(spec)
sys.modules['engine_jobs'] = package
spec.loader.exec_module(package)
from engine_jobs.policy import OWNER, prepare_job
from engine_jobs.runtime import Job, cleanup, execute_job
from engine_jobs.workloads import verified_container

JOB = 'cc1db821-430f-4c13-b4bd-f7c927e31dcb'


def request(commands=None):
    return {'job': JOB, 'commands': commands or [['run', '--name', 'app', 'sdk:cached', 'true']],
            'workspace': {'cwd': '/project', 'bindings': ['/project'], 'readOnlyBindings': [],
                          'masked': [], 'uid': 1000, 'gid': 1000}, 'network': 'none',
            'limits': {'memoryMiB': 512, 'cpus': 1, 'pids': 64}}


def manifest(service=None):
    return {'config': {'services': {'app': service or {'image': 'sdk:cached'}}}, 'arguments': ['up', '-d']}


def state():
    return {'Id': 'a' * 64, 'Config': {'Labels': {OWNER: JOB}}, 'Mounts': [],
            'HostConfig': {'Memory': 512 * 1048576, 'MemorySwap': 512 * 1048576,
                           'PidsLimit': 64, 'CpuPeriod': 100000, 'CpuQuota': 100000}}


class PolicyTests(unittest.TestCase):
    def test_run_budget_and_no_literal_flag_rewrite(self):
        data = request([['run', '-d', '--env', 'VALUE=-d', 'sdk:cached', 'echo', '-d']])
        plan = prepare_job(data)
        command = plan['commands'][0]
        self.assertTrue(command['detached'])
        self.assertIn('VALUE=-d', command['argv'])
        self.assertEqual(command['argv'][-1], '-d')
        self.assertIn('--memory-swap', command['argv'])
        self.assertEqual(plan['perContainerLimits']['pids'], 64)

    def test_admin_existing_targets_and_escape_flags_rejected(self):
        cases = [['system', 'prune'], ['stop', 'lubox'], ['exec', 'lubox', 'true'],
                 ['run', '--privileged', 'sdk'], ['run', '--mount', 'type=bind,src=/,dst=/host', 'sdk'],
                 ['run', '--env', 'OPENAI_API_KEY', 'sdk'], ['run', '--network', 'host', 'sdk'],
                 ['run', '--device', '/dev/kvm', 'sdk'], ['--host', 'unix:///socket', 'ps'], ['info', '--root', '/private'],
                 ['ps', '--log-file', '/private/file'], ['run', 'dir:/private'],
                 ['run', '--security-opt', 'seccomp=unconfined', 'sdk'], ['build', '.']]
        for argv in cases:
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                prepare_job(request([argv]))

    def test_project_mounts_exact_and_readonly(self):
        data = request([['run', '-v', '/project:/app:ro', 'sdk']])
        self.assertEqual(prepare_job(data)['commands'][0]['mounts'], [
            {'source': '/project', 'target': '/app', 'readOnly': True}])
        data['workspace']['readOnlyBindings'] = ['/project']
        data['commands'][0][2] = '/project:/app:rw'
        with self.assertRaises(ValueError):
            prepare_job(data)

    def test_protected_descendants_and_child_aliases_rejected(self):
        data = request()
        data['workspace']['masked'] = [{'path': '/project/.secrets', 'directory': True}]
        with self.assertRaises(ValueError):
            prepare_job(data)
        data = request([['run', '-v', '/project/child:/app', 'sdk']])
        with self.assertRaises(ValueError):
            prepare_job(data)

    def test_no_network_pull_or_ports_and_no_storage_guarantee_downgrade(self):
        for argv in [['pull', 'sdk'], ['run', '-p', '127.0.0.1:8080:80', 'sdk']]:
            with self.assertRaises(ValueError):
                prepare_job(request([argv]))
        transport = request([['pull', 'docker-archive:/private/archive']])
        transport['network'] = 'host'
        transport['limits'] = {}
        with self.assertRaisesRegex(ValueError, 'transports'):
            prepare_job(transport)
        data = request()
        data['limits']['tmpBytes'] = 1048576
        with self.assertRaisesRegex(ValueError, 'cannot be dropped'):
            prepare_job(data)

    def test_batch_budget_divided_and_targets_owned(self):
        data = request([['run', '--name', 'one', '-d', 'sdk'], ['run', '--name', 'two', '-d', 'sdk'],
                        ['exec', 'one', 'echo', 'ok']])
        plan = prepare_job(data)
        self.assertEqual(plan['perContainerLimits']['memoryMiB'], 256)
        self.assertEqual(plan['perContainerLimits']['pids'], 32)
        self.assertEqual(plan['perContainerLimits']['cpus'], .5)
        self.assertIn('pi-' + JOB + '-one', plan['commands'][2]['argv'])
        with self.assertRaises(ValueError):
            prepare_job(request([['run', '--name', 'same', 'sdk'], ['run', '--name', 'same', 'sdk']]))

    def test_compose_freezes_limits_names_network_and_no_recreate(self):
        data = request([['compose', 'up', '-d']])
        data['compose'] = {'0': manifest()}
        result = prepare_job(data)['commands'][0]
        service = result['config']['services']['app']
        self.assertEqual(service['labels'][OWNER], JOB)
        self.assertEqual(service['pids_limit'], 64)
        self.assertTrue(result['config']['networks']['default']['internal'])
        self.assertEqual(service['pull_policy'], 'never')
        self.assertIn('--no-recreate', result['arguments'])

    def test_compose_privileges_external_resources_and_run_override_rejected(self):
        cases = [{'image': 'sdk', 'privileged': True}, {'image': 'sdk', 'build': '.'},
                 {'image': 'sdk', 'volumes': ['/run/docker.sock:/socket']},
                 {'image': 'sdk', 'network_mode': 'host'}, {'image': 'sdk', 'container_name': 'lubox'},
                 {'image': 'sdk', 'provider': {'type': 'arbitrary'}}]
        for service in cases:
            data = request([['compose', 'up', '-d']])
            data['compose'] = {'0': manifest(service)}
            with self.subTest(service=service), self.assertRaises(ValueError):
                prepare_job(data)
        for argv in [['run', '-v', '/:/host', 'app', 'true'], ['up', '--scale', 'app=100']]:
            data['compose']['0'] = manifest()
            data['compose']['0']['arguments'] = argv
            with self.assertRaises(ValueError):
                prepare_job(data)

    def test_metadata_never_mutates_and_requires_no_workload_cgroup(self):
        data = request([['version']])
        data['limits'] = {'executionTimeoutMs': 10000}
        self.assertEqual(prepare_job(data)['workloadCount'], 0)
        data['limits']['memoryMiB'] = 512
        with self.assertRaisesRegex(ValueError, 'no private workload cgroup'):
            prepare_job(data)

    def test_prestart_checks_ownership_limits_mounts_and_namespaces(self):
        data = request()
        engine = object()
        with patch('engine_jobs.workloads.read_json', return_value=[state()]):
            self.assertEqual(verified_container(engine, 'app', JOB, data['limits'], {}, '/project', data['workspace']), 'a' * 64)
        mutations = [lambda s: s['Config']['Labels'].clear(),
                     lambda s: s['HostConfig'].update(Memory=1),
                     lambda s: s['HostConfig'].update(MemorySwap=-1),
                     lambda s: s['HostConfig'].update(PidMode='host'),
                     lambda s: s['Mounts'].append({'Type': 'bind', 'Source': '/run/docker.sock'})]
        for mutate in mutations:
            value = state()
            mutate(value)
            with patch('engine_jobs.workloads.read_json', return_value=[value]), self.assertRaises(ValueError):
                verified_container(engine, 'app', JOB, data['limits'], {}, '/project', data['workspace'])

    def test_cleanup_refuses_foreign_resource_and_never_global_prunes(self):
        calls = []
        def capture(_engine, argv, *_args, **_kwargs):
            calls.append(argv)
            return {'exitCode': 0, 'stdout': 'a' * 64, 'stderr': ''}
        foreign = state()
        foreign['Config']['Labels'].clear()
        with patch('engine_jobs.runtime.capture', side_effect=capture), patch('engine_jobs.runtime.read_json', return_value=[foreign]):
            with self.assertRaises(ValueError):
                cleanup(object(), JOB, {}, '/project')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ['ps', '--all'])
        self.assertNotIn('prune', str(calls))

    def test_failed_prestart_verification_never_starts_payload(self):
        data = request()
        plan = prepare_job(data)
        with tempfile.TemporaryDirectory() as temporary:
            job = object.__new__(Job)
            job.engine = type('Engine', (), {'name': 'docker'})()
            job.request, job.plan = data, plan
            job.directory, job.cwd, job.environment = pathlib.Path(temporary), '/project', {}
            job.rootless = False
            calls = []
            def call(argv):
                calls.append(argv)
                (job.directory / 'container-0').write_text('a' * 64)
                return {'exitCode': 0, 'stdout': '', 'stderr': ''}
            job.call = call
            with patch('engine_jobs.runtime.projected_mounts', return_value=[]), patch('engine_jobs.runtime.verified_container', side_effect=ValueError('controls missing')):
                with self.assertRaisesRegex(ValueError, 'controls missing'):
                    job.run(plan['commands'][0], 0)
            self.assertEqual([argv[0] for argv in calls], ['create'])

    def test_cancel_tombstone_stops_late_create_without_starting_another_command(self):
        data = request()
        with tempfile.TemporaryDirectory() as temporary:
            marker = pathlib.Path(temporary) / 'cancelled'
            marker.touch()
            job = object.__new__(Job)
            job.request = data
            with patch('engine_jobs.runtime.cancellation_path', return_value=marker), patch('engine_jobs.runtime.capture') as capture:
                with self.assertRaises(InterruptedError):
                    job.call(['start', 'a' * 64])
                capture.assert_not_called()

    def test_compose_create_verifies_limits_before_any_up_command(self):
        data = request([['compose', 'up', '-d']])
        data['compose'] = {'0': manifest()}
        plan = prepare_job(data)
        with tempfile.TemporaryDirectory() as temporary:
            job = object.__new__(Job)
            job.engine = type('Engine', (), {'name': 'docker'})()
            job.request, job.plan = data, plan
            job.directory, job.cwd, job.environment = pathlib.Path(temporary), '/project', {}
            job.rootless = False
            calls = []
            def call(argv, *_args):
                calls.append(argv)
                return {'exitCode': 0, 'stdout': 'a' * 64 if 'ps' in argv else '', 'stderr': ''}
            job.call = call
            with patch('engine_jobs.runtime.verified_container', side_effect=ValueError('limits missing')):
                with self.assertRaises(ValueError):
                    job.compose(plan['commands'][0], 0)
            self.assertTrue(any('create' in argv for argv in calls))
            self.assertFalse(any('up' in argv for argv in calls))


if __name__ == '__main__':
    unittest.main()
