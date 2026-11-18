"""Portable, additive Muso migration. Archives never contain credentials or raw SQL."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import time
import uuid
import zipfile

MAX_BYTES = 10 * 1024 ** 3
SAFE_AUDIO = re.compile(r'[A-Za-z0-9_-]+\.(?:mp3|m4a|flac|wav|ogg|opus|aac|webm)\Z')


def export_library(root, destination):
    root, destination = Path(root).expanduser().resolve(), Path(destination).expanduser().resolve()
    db = sqlite3.connect(f'{(root / "muso.sqlite3").as_uri()}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute('BEGIN')
        tracks = [dict(row) for row in db.execute('SELECT * FROM tracks')]
        playlists = [dict(row) for row in db.execute('SELECT * FROM playlists')]
        for playlist in playlists:
            playlist['tracks'] = [row[0] for row in db.execute('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position', (playlist['id'],))]
        events = [dict(row) for row in db.execute('SELECT track_id,title,artist,played_at FROM listening_events')]
        metadata = dict(format='muso-portable-1', tracks=tracks, playlists=playlists, events=events)
        for track in tracks:
            if not SAFE_AUDIO.fullmatch(track['filename']):
                raise ValueError('Invalid library filename')
        with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            archive.writestr('muso-backup.json', json.dumps(metadata, ensure_ascii=False, allow_nan=False))
            for track in tracks:
                archive.write(root / 'media' / track['filename'], 'media/' + track['filename'])
    finally:
        db.close()
    return len(tracks)


def import_library(store, source):
    saved = duplicates = 0
    errors = []
    mapped = {}
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 50001 or len(names) != len(set(names)) or sum(e.file_size for e in entries) > MAX_BYTES:
            raise ValueError('Backup is too large or has duplicate entries.')
        for entry in entries:
            if entry.filename != 'muso-backup.json' and not (entry.filename.startswith('media/') and SAFE_AUDIO.fullmatch(entry.filename[6:])):
                raise ValueError('Backup contains an invalid path.')
            if entry.file_size > 512 * 1024 ** 2 and entry.filename != 'muso-backup.json':
                raise ValueError('Backup contains an oversized audio file.')
        if archive.getinfo('muso-backup.json').file_size > 20 * 1024 ** 2:
            raise ValueError('Backup metadata is too large.')
        metadata = json.loads(archive.read('muso-backup.json'))
        if metadata.get('format') != 'muso-portable-1':
            raise ValueError('Choose a Muso portable backup ZIP.')
        tracks, playlists, events = (metadata.get(key, []) for key in ('tracks', 'playlists', 'events'))
        if not all(isinstance(rows, list) for rows in (tracks, playlists, events)) or len(tracks) > 50000 or len(playlists) > 10000 or len(events) > 200000:
            raise ValueError('Invalid backup metadata.')
        for track in tracks:
            if not isinstance(track, dict) or not SAFE_AUDIO.fullmatch(str(track.get('filename', ''))) or not isinstance(track.get('id'), str):
                raise ValueError('Invalid backup track.')
            archive.getinfo('media/' + track['filename'])
        needed = sum(archive.getinfo('media/' + t['filename']).file_size for t in tracks)
        if needed + 100 * 1024 ** 2 > shutil.disk_usage(store.root).free:
            raise ValueError('Not enough free space to import this backup.')
        for track in tracks:
            path = store.temp / (uuid.uuid4().hex + Path(track['filename']).suffix)
            try:
                with archive.open('media/' + track['filename']) as input_file, path.open('xb') as output:
                    shutil.copyfileobj(input_file, output, 1024 * 1024)
                if track.get('fingerprint'):
                    with path.open('rb') as audio:
                        if hashlib.file_digest(audio, 'sha256').hexdigest() != track['fingerprint']:
                            raise ValueError('Audio checksum mismatch')
                result = {}
                track_id = store.add_track(path, track, result=result)
                mapped[track['id']] = track_id
                if result.get('duplicate'): duplicates += 1
                else: saved += 1
                with store.db() as db:
                    db.execute('UPDATE tracks SET liked=MAX(liked,?),plays=MAX(plays,?),last_played=MAX(COALESCE(last_played,0),?) WHERE id=?',
                               (int(bool(track.get('liked'))), max(0, int(track.get('plays', 0))), float(track.get('last_played') or 0), track_id))
            except Exception as exc:
                errors.append(f"{str(track.get('title', 'Audio'))[:100]}: {str(exc)[:150]}")
            finally:
                path.unlink(missing_ok=True)
        with store.db() as db:
            for playlist in playlists:
                if not isinstance(playlist, dict) or not isinstance(playlist.get('tracks'), list):
                    continue
                # Stable namespace prevents repeated restores from duplicating playlists.
                playlist_id = 'backup-' + hashlib.sha256(str(playlist.get('id', '')).encode()).hexdigest()[:32]
                db.execute('INSERT OR IGNORE INTO playlists VALUES (?,?,?)', (playlist_id, str(playlist.get('name') or 'Imported playlist')[:80], time.time()))
                existing = [row[0] for row in db.execute('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position', (playlist_id,))]
                for old_id in playlist['tracks']:
                    track_id = mapped.get(old_id)
                    if track_id and track_id not in existing:
                        db.execute('INSERT INTO playlist_tracks VALUES (?,?,?)', (playlist_id, track_id, len(existing)))
                        existing.append(track_id)
            for event in events:
                if not isinstance(event, dict): continue
                track_id = mapped.get(event.get('track_id'))
                if not track_id: continue
                try: played_at = float(event['played_at'])
                except (KeyError, TypeError, ValueError): continue
                db.execute('''INSERT INTO listening_events(track_id,title,artist,played_at)
                    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM listening_events WHERE track_id=? AND played_at=?)''',
                    (track_id, str(event.get('title') or '')[:300], str(event.get('artist') or '')[:300], played_at, track_id, played_at))
    return dict(saved=saved, duplicates=duplicates, errors=errors)
