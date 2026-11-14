"""Exercise supervision using real processes and temporary libraries only."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('muso_supervise', REPO / 'termux/supervise.py')
supervise = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(supervise)


def wait_for(check, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.05)
    raise AssertionError('Process did not reach expected state')


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.env = dict(os.environ, MUSO_DATA_DIR=str(self.root), MUSO_PORT=str(self.port))

    def launch(self, script, **kwargs):
        child = subprocess.Popen([sys.executable, str(script)], env=self.env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True, **kwargs)
        def cleanup():
            supervise.terminate(child)
            supervise.stop_checkout(self.root)
        self.addCleanup(cleanup)
        return child

    def app_pids(self):
        found = []
        for proc in Path('/proc').iterdir():
            if proc.name.isdigit() and supervise.matching_process(int(proc.name), self.root):
                try:
                    if str(REPO / 'app.py').encode() in (proc / 'cmdline').read_bytes().split(b'\0'):
                        found.append(int(proc.name))
                except OSError:
                    pass
        return found

    def test_crashed_server_restarts_and_duplicate_supervisor_exits(self):
        manager = self.launch(REPO / 'termux/supervise.py')
        wait_for(lambda: supervise.healthy(self.port))
        before = self.app_pids()
        self.assertEqual(len(before), 1)
        duplicate = self.launch(REPO / 'termux/supervise.py')
        self.assertEqual(duplicate.wait(timeout=3), 0)
        self.assertEqual(self.app_pids(), before)
        os.kill(before[0], signal.SIGKILL)
        wait_for(lambda: supervise.healthy(self.port) and self.app_pids() != before)
        self.assertIsNone(manager.poll())
        self.assertEqual(len(self.app_pids()), 1)
        manager.terminate()
        manager.wait(timeout=8)
        wait_for(lambda: not supervise.healthy(self.port))

    def test_replacement_supervisor_adopts_live_orphan_without_duplicate(self):
        manager = self.launch(REPO / 'termux/supervise.py')
        wait_for(lambda: supervise.healthy(self.port))
        before = self.app_pids()
        manager.kill()
        manager.wait(timeout=3)
        replacement = self.launch(REPO / 'termux/supervise.py')
        time.sleep(.5)
        self.assertIsNone(replacement.poll())
        self.assertEqual(self.app_pids(), before)
        os.kill(before[0], signal.SIGKILL)
        wait_for(lambda: supervise.healthy(self.port) and self.app_pids() != before)
        self.assertEqual(len(self.app_pids()), 1)

    def test_watchdog_kills_hung_child_but_tolerates_transient_failure(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
        self.addCleanup(supervise.terminate, child)
        with patch.object(supervise, 'healthy', side_effect=[False, True, False, False, False]) as probe:
            supervise.monitor(child, self.port, interval=.01, grace=0, failures=3)
        self.assertEqual(probe.call_count, 5)
        self.assertIsNotNone(child.poll())

    def test_stop_targets_checkout_and_library_only(self):
        server = self.launch(REPO / 'app.py')
        wait_for(lambda: supervise.healthy(self.port))
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], env=self.env)
        self.addCleanup(unrelated.kill)
        self.assertFalse(supervise.matching_process(unrelated.pid, self.root))
        self.assertFalse(supervise.matching_process(server.pid, self.root / 'other-library'))
        supervise.stop_checkout(self.root)
        server.wait(timeout=3)
        self.assertIsNone(unrelated.poll())
        unrelated.terminate()
        unrelated.wait(timeout=3)

    def test_health_rejects_other_services_and_ignores_proxy_environment(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'app': 'Akhlaq', 'ok': True}).encode())
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', self.port), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, http_proxy='http://127.0.0.1:1'):
                self.assertFalse(supervise.healthy(self.port))
        finally:
            server.shutdown()
            server.server_close()
