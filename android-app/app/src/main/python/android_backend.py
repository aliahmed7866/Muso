"""In-process Muso backend: no socket, server, shell or Termux dependency."""
import json
import re
import threading
import time
from pathlib import Path

_web = None
_store = None


def start(root, assets, worker=True):
    global _web, _store
    if _web is not None:
        return
    from app import create_app
    import importer
    import android_downloader
    try:
        import java
    except ImportError:
        pass  # Desktop backend tests do not have Android Java classes.
    else:
        import android_challenge
    importer.search = android_downloader.search
    importer.download = android_downloader.download
    _web = create_app(root)
    _web.template_folder = str(Path(assets) / 'templates')
    _web.static_folder = str(Path(assets) / 'static')
    _store = _web.extensions['store']
    # Discovery remains opt-in on a fresh Android install, avoiding unexpected downloads.
    with _store.db() as db:
        db.execute("INSERT OR IGNORE INTO preferences VALUES ('discovery','0')")
    if worker:
        threading.Thread(target=_store.worker, daemon=True, name='muso-imports').start()


def asset(path):
    if path != '/' and not re.fullmatch(r'/static/[a-zA-Z0-9_.-]+', path):
        raise ValueError('Unknown app resource')
    with _web.test_client() as client:
        response = client.get(path, base_url='http://localhost')
        if response.status_code != 200:
            raise ValueError('App resource unavailable')
        data = response.get_data()
        if path == '/':
            data = data.replace(b'<script defer src="/static/sound.js">',
                                b'<script defer src="/static/android.js"></script><script defer src="/static/sound.js">')
        return response.mimetype, data


def api(path, method, body):
    if not path.startswith('/api/') or '#' in path or '..' in path:
        raise ValueError('Invalid API path')
    if method not in ('GET', 'POST', 'PATCH', 'DELETE') or path.endswith('/audio') or path == '/api/upload':
        raise ValueError('Invalid API operation')
    with _web.test_client() as client:
        response = client.open(path, method=method, base_url='http://localhost',
                               headers={'X-Muso-Token': _store.token},
                               json=json.loads(body) if body else None)
        return json.dumps({'status': response.status_code, 'data': response.get_json()})


def items(ids):
    ids = json.loads(ids)
    if not isinstance(ids, list) or len(ids) > 10000:
        raise ValueError('Queue is too large')
    with _store.db() as db:
        tracks = {row['id']: dict(row) for row in db.execute('SELECT * FROM tracks')}
    result = []
    for track_id in ids:
        track = tracks.get(track_id)
        if track is None:
            continue
        path = (_store.media / track['filename']).resolve()
        if path.parent != _store.media or not path.is_file():
            continue
        result.append(dict(id=track_id, title=track['title'], artist=track['artist'],
                           album=track['album'], path=str(path)))
    return json.dumps(result)


def played(track_id):
    return api('/api/tracks/' + track_id + '/played', 'POST', '{}')


def import_file(path, filename):
    import mutagen
    path = Path(path)
    if path.parent.resolve() != _store.temp.resolve():
        raise ValueError('Invalid import file')
    try:
        ext = Path(filename).suffix.lower()
        if ext not in {'.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac'}:
            raise ValueError('Choose MP3, M4A, FLAC, WAV, OGG, Opus or AAC audio.')
        audio = mutagen.File(path, easy=True)
        if audio is None or not getattr(audio, 'info', None):
            raise ValueError('This file is not readable audio.')
        tags = audio.tags or {}
        metadata = dict(title=(tags.get('title') or [Path(filename).stem])[0],
                        artist=(tags.get('artist') or ['Unknown artist'])[0],
                        album=(tags.get('album') or [''])[0], duration=audio.info.length,
                        genre=(tags.get('genre') or [''])[0], source='local', codec=ext.lstrip('.'),
                        bitrate=round((getattr(audio.info, 'bitrate', 0) or 0) / 1000))
        result = {}
        track_id = _store.add_track(path, metadata, result=result)
        return json.dumps(dict(id=track_id, duplicate=result.get('duplicate', False)))
    finally:
        path.unlink(missing_ok=True)


def import_backup(path):
    from backup import import_library
    path = Path(path)
    if path.parent.resolve() != _store.temp.resolve():
        raise ValueError('Invalid backup location')
    try:
        return json.dumps(import_library(_store, path))
    finally:
        path.unlink(missing_ok=True)
