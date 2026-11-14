"""Optional Linux integration tests with real runit, in a disposable prefix."""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import build_opener, ProxyHandler

REPO = Path(__file__).resolve().parents[1]
RUNIT = os.environ.get('MUSO_TEST_RUNIT_BIN')
HTTP = build_opener(ProxyHandler({}))


@unittest.skipUnless(RUNIT, 'Set MUSO_TEST_RUNIT_BIN to sv/runsv/runsvdir for isolated service tests')
class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='muso-service-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.repo, self.prefix, self.home = root / 'Muso checkout', root / 'prefix', root / 'home'
        self.bin = self.prefix / 'bin'
        self.service = self.prefix / 'var/service/muso'
        self.bin.mkdir(parents=True)
        self.home.mkdir()
        shutil.copytree(REPO / 'termux', self.repo / 'termux')
        (self.repo / '.venv/bin').mkdir(parents=True)
        (self.repo / '.venv/bin/python').symlink_to(sys.executable)
        (self.bin / 'bash').symlink_to(shutil.which('bash'))
        (self.bin / 'sh').symlink_to(shutil.which('sh'))
        for name in ('sv', 'runsv', 'runsvdir'):
            (self.bin / name).symlink_to(Path(RUNIT) / name)
        # Test service-daemon adapter starts actual runsvdir. Termux's packaged
        # service-daemon uses start-stop-daemon for the same operation.
        self.write_executable(self.bin / 'service-daemon', '''#!{python}
import os, pathlib, subprocess, sys
root = pathlib.Path(os.environ['PREFIX'])
with (root / 'daemon-calls').open('a') as log: log.write(sys.argv[1] + '\\n')
assert sys.argv[1] == 'start', 'Must never stop or restart shared services'
pidfile = root / 'daemon.pid'
try:
    os.kill(int(pidfile.read_text()), 0)
except (OSError, ValueError):
    child = subprocess.Popen(['runsvdir', os.environ['SVDIR']], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    pidfile.write_text(str(child.pid))
'''.format(python=sys.executable))
        self.write_executable(self.bin / 'termux-wake-lock', '#!/bin/sh\nexit 0\n')
        (self.repo / 'app.py').write_text('''import fcntl, json, os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root = Path(os.environ['MUSO_DATA_DIR'])
root.mkdir(parents=True, exist_ok=True)
lock = (root / 'server.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'app': 'Muso', 'ok': True, 'pid': os.getpid()}, separators=(',', ':')).encode())
    def log_message(self, *_): pass
ThreadingHTTPServer(('127.0.0.1', int(os.environ['MUSO_PORT'])), Handler).serve_forever()
''')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.env = dict(os.environ, PREFIX=str(self.prefix), HOME=str(self.home),
                        PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        MUSO_PORT=str(self.port), MUSO_DATA_DIR=str(root / 'music data'))
        self.addCleanup(self.cleanup_processes)
        # A real neighbouring service must keep the same PID throughout repairs.
        other = self.prefix / 'var/service/akhlaq'
        other.mkdir(parents=True)
        self.write_executable(other / 'run', '#!/bin/sh\nexec sleep 3600\n')
        self.other = other
        hooks = self.home / '.termux/boot'
        hooks.mkdir(parents=True)
        (hooks / 'akhlaq').write_text('user owned boot hook\n')

    def write_executable(self, path, text):
        path.write_text(text)
        path.chmod(0o700)

    def cleanup_processes(self):
        subprocess.run(['bash', str(self.repo / 'termux/service.sh'), 'stop'], env=self.env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        try:
            pid = int((self.prefix / 'daemon.pid').read_text())
            os.killpg(pid, signal.SIGTERM)
        except (OSError, ValueError):
            pass
        # Stop neighbouring runsv and its sleep child before removing the prefix.
        subprocess.run([str(self.bin / 'sv'), 'force-stop', str(self.other)], env=self.env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        for service in (self.service, self.other):
            subprocess.run([str(self.bin / 'sv'), 'exit', str(service)], env=self.env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)

    def command(self, *args, check=True, env=None):
        result = subprocess.run(['bash', str(self.repo / 'termux/service.sh'), *args], env=env or self.env,
                                capture_output=True, text=True, timeout=40)
        if check:
            log = Path(self.env['MUSO_DATA_DIR']) / 'server.log'
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr + (log.read_text()[-4000:] if log.exists() else ''))
        return result

    def health(self):
        try:
            with HTTP.open(f'http://127.0.0.1:{self.port}/api/health', timeout=.3) as response:
                return json.load(response)
        except (OSError, ValueError):
            return None

    def wait_for(self, check, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if check(): return
            time.sleep(.05)
        self.fail('Timed out waiting for service: ' + self.command('status', check=False).stdout)

    def test_install_recovery_hooks_stop_and_idempotent_repair(self):
        self.command('install')
        self.wait_for(lambda: self.health())
        other_pid = (self.other / 'supervise/pid').read_bytes()
        before = self.health()['pid']
        os.kill(before, signal.SIGKILL)
        self.wait_for(lambda: self.health() and self.health()['pid'] != before)
        supervisor_pid = int((self.service / 'supervise/pid').read_text())
        os.kill(supervisor_pid, signal.SIGKILL)
        self.wait_for(lambda: int((self.service / 'supervise/pid').read_text() or '0') not in (0, supervisor_pid))
        self.assertTrue(self.health())
        self.command('install')
        self.assertEqual((self.other / 'supervise/pid').read_bytes(), other_pid)
        self.assertEqual((self.home / '.termux/boot/akhlaq').read_text(), 'user owned boot hook\n')
        self.command('stop')
        self.assertIsNone(self.health())
        self.command('auto')
        time.sleep(.3)
        self.assertIsNone(self.health(), 'Explicit stop must survive startup hooks')
        self.command('start')
        self.wait_for(lambda: self.health())
        # Simulate an enabled service being down; the login hook brings it up.
        subprocess.run([str(self.bin / 'sv'), '-w', '10', 'down', str(self.service)], env=self.env, check=True, capture_output=True)
        self.wait_for(lambda: not self.health())
        subprocess.run(['sh', str(self.prefix / 'etc/profile.d/muso-autostart.sh')], env=self.env, check=True)
        self.wait_for(lambda: self.health())
        # The boot hook uses the same recovery without changing another app.
        subprocess.run([str(self.bin / 'sv'), '-w', '10', 'down', str(self.service)], env=self.env, check=True, capture_output=True)
        self.wait_for(lambda: not self.health())
        subprocess.run(['sh', str(self.home / '.termux/boot/90-muso')], env=self.env, check=True)
        self.wait_for(lambda: self.health())
        self.assertEqual((self.other / 'supervise/pid').read_bytes(), other_pid)
        self.assertEqual(set((self.prefix / 'daemon-calls').read_text().splitlines()), {'start'})
        # Persisted port/data settings work even without caller exports.
        plain = {k: v for k, v in self.env.items() if k not in ('MUSO_PORT', 'MUSO_DATA_DIR')}
        self.command('status', env=plain)

    def test_refuse_unmanaged_service(self):
        self.service.mkdir()
        (self.service / 'run').write_text('leave me alone')
        result = self.command('install', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.service / 'run').read_text(), 'leave me alone')
        self.assertFalse((self.prefix / 'daemon-calls').exists())
