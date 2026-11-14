"""Restart the local Muso server while Termux is running."""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def main():
    root = Path(os.environ["MUSO_DATA_DIR"]).expanduser()
    app = Path(__file__).resolve().parents[1] / "app.py"
    with (root / "supervisor.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return

        def stop(*_):
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, stop)
        child = None
        delay = 1
        try:
            while True:
                started = time.monotonic()
                child = subprocess.Popen([sys.executable, str(app)], start_new_session=True)
                status = child.wait()
                if time.monotonic() - started >= 60:
                    delay = 1
                print(f"Muso exited ({status}). Restarting in {delay}s.", flush=True)
                time.sleep(delay)
                delay = min(delay * 2, 30)
        finally:
            if child is not None and child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=5)
                except ProcessLookupError:
                    pass
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()


if __name__ == "__main__":
    main()
