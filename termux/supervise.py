"""Supervise only this Muso checkout; recover exits and unresponsive HTTP workers."""
import fcntl
import json
from http.client import HTTPException
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.request import build_opener, ProxyHandler

APP = Path(__file__).resolve().parents[1] / "app.py"
HTTP = build_opener(ProxyHandler({}))


def healthy(port):
    try:
        with HTTP.open(f"http://127.0.0.1:{port}/api/health", timeout=3) as response:
            data = json.load(response)
            return isinstance(data, dict) and data.get("app") == "Muso" and data.get("ok") is True
    except (OSError, ValueError, HTTPException):
        return False


def terminate(child):
    if child is None or child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=5)
    except ProcessLookupError:
        pass
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()


def monitor(child, port, interval=5, grace=30, failures=3):
    """A few missed probes are tolerated; a live but hung child is recycled."""
    started = time.monotonic()
    missed = 0
    while child.poll() is None:
        try:
            return child.wait(timeout=interval)
        except subprocess.TimeoutExpired:
            pass
        if time.monotonic() - started < grace:
            continue
        missed = 0 if healthy(port) else missed + 1
        if missed >= failures:
            print("Muso stopped responding to health checks. Restarting its server.", flush=True)
            terminate(child)
            return child.returncode
    return child.returncode


def matching_process(pid, root):
    """Recognise old pre-service launches without broad python/node/pkill matches."""
    if pid == os.getpid():
        return False
    try:
        proc = Path('/proc') / str(pid)
        args = (proc / 'cmdline').read_bytes().split(b'\0')
        if len(args) < 2:
            return False
        # Both historical launchers used an absolute script path. Do not match
        # arbitrary command strings, other checkouts, or someone else's library.
        script = args[1].decode()
        if script == '-u' and len(args) > 2:
            script = args[2].decode()
        if script not in (str(APP), str(Path(__file__).resolve())):
            return False
        env = dict(item.split(b'=', 1) for item in (proc / 'environ').read_bytes().split(b'\0') if b'=' in item)
        data = Path(os.fsdecode(env.get(b'MUSO_DATA_DIR', b''))).expanduser().resolve()
        return data == root.resolve()
    except (OSError, ValueError, UnicodeError):
        return False


def stop_checkout(root):
    # runit must be down first, otherwise it would correctly restart these PIDs.
    pids = [int(p.name) for p in Path('/proc').iterdir()
            if p.name.isdigit() and matching_process(int(p.name), root)]
    for pid in pids:
        if matching_process(pid, root):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline and any(matching_process(pid, root) for pid in pids):
        time.sleep(.1)
    for pid in pids:
        if matching_process(pid, root):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def main():
    root = Path(os.environ["MUSO_DATA_DIR"]).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    if sys.argv[1:] == ['stop']:
        stop_checkout(root)
        return
    port = int(os.environ.get('MUSO_PORT', '8765'))
    with (root / "supervisor.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            # A service can take over from a legacy supervisor once it exits.
            return

        def stop(*_):
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        child = None
        delay = 1
        orphan_misses = 0
        try:
            while True:
                # If a foreground/legacy server already owns this library, wait
                # for its lock instead of creating a failing child every second.
                with (root / 'server.lock').open('a') as server_lock:
                    try:
                        fcntl.flock(server_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        # A killed supervisor can leave its server alive. Keep
                        # watching it rather than waiting forever on its lock.
                        orphan_misses = 0 if healthy(port) else orphan_misses + 1
                        if orphan_misses >= 6:
                            print("Existing Muso server is unresponsive. Recovering it.", flush=True)
                            stop_checkout(root)
                            orphan_misses = 0
                        time.sleep(5)
                        continue
                orphan_misses = 0
                started = time.monotonic()
                child = subprocess.Popen([sys.executable, str(APP)], start_new_session=True)
                status = monitor(child, port)
                if time.monotonic() - started >= 60:
                    delay = 1
                print(f"Muso exited ({status}). Restarting in {delay}s.", flush=True)
                time.sleep(delay)
                delay = min(delay * 2, 30)
        finally:
            terminate(child)


if __name__ == "__main__":
    main()
