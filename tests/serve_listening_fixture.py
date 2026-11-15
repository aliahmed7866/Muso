"""Temporary library for browser tests. Never uses the real Muso data directory."""
import sys
import signal
import tempfile
import time
import wave
import os
import math
import struct
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from werkzeug.serving import make_server

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

with tempfile.TemporaryDirectory(prefix="muso-listening-test-") as root:
    app = create_app(root)
    store = app.extensions["store"]
    now = time.time()
    with store.db() as db:
        db.execute("INSERT OR REPLACE INTO preferences VALUES ('discovery','0')")
        for i, (title, liked, plays, last_played, created) in enumerate([
            ("Amber", 1, 10, now - 30 * 86400, now - 60 * 86400),
            ("Blue", 0, 0, None, now),
            ("Coral", 1, 3, now, now - 40 * 86400),
            ("Dawn", 0, 0, None, now),
        ]):
            filename = f"{i}.wav"
            with wave.open(str(store.media / filename), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(8000)
                if os.environ.get('MUSO_TEST_TONE') == '1':
                    second = b''.join(struct.pack('<h', round(2500 * math.sin(2 * math.pi * (440 + i * 220) * n / 8000))) for n in range(8000))
                    wav.writeframes(second * 120)
                else:
                    wav.writeframes(b"\x00\x00" * 8000 * 120)
            db.execute("""INSERT INTO tracks
                (id,title,artist,album,duration,filename,source,liked,plays,last_played,created)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (str(i), title, "Artist " + str(i), "Test Album", 120, filename, "local", liked, plays, last_played, created))
        db.execute("INSERT INTO playlists VALUES ('sample','Sample playlist',?)", (now,))
        db.execute("INSERT INTO playlist_tracks VALUES ('sample','0',0)")
    server = make_server("127.0.0.1", 0, app, threaded=True)
    print(f"http://127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()

