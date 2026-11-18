"""Portable Muso backups and a standalone, standard-library-only Termux exporter."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import time
import uuid
import zipfile

MAX_BYTES = 10 * 1024 ** 3
RESERVE = 100 * 1024 ** 2
SAFE_AUDIO = re.compile(r'[A-Za-z0-9_-]+\.(?:mp3|m4a|flac|wav|ogg|opus|aac|webm)\Z')


def _number(value, label, maximum=1e15):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= maximum:
        raise ValueError('Invalid backup ' + label + '.')
    return value


def _metadata(archive):
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    if len(entries) > 50001 or len(names) != len(set(names)) or sum(e.file_size for e in entries) > MAX_BYTES:
        raise ValueError('Backup is too large or has duplicate entries.')
    for entry in entries:
        if entry.filename != 'muso-backup.json' and not (entry.filename.startswith('media/') and SAFE_AUDIO.fullmatch(entry.filename[6:])):
            raise ValueError('Backup contains an invalid path.')
        limit = 20 * 1024 ** 2 if entry.filename == 'muso-backup.json' else 512 * 1024 ** 2
        if entry.file_size > limit or entry.flag_bits & 1:
            raise ValueError('Backup contains an oversized or encrypted file.')
    try:
        metadata = json.loads(archive.read('muso-backup.json'))
    except (KeyError, ValueError) as exc:
        raise ValueError('Choose a Muso portable backup ZIP.') from exc
    if not isinstance(metadata, dict) or metadata.get('format') != 'muso-portable-1':
        raise ValueError('Choose a Muso portable backup ZIP.')
    tracks, playlists, events = (metadata.get(key, []) for key in ('tracks', 'playlists', 'events'))
    if not all(isinstance(rows, list) for rows in (tracks, playlists, events)) or len(tracks) > 50000 or len(playlists) > 10000 or len(events) > 200000:
        raise ValueError('Invalid backup metadata.')
    ids, filenames = set(), set()
    for track in tracks:
        if not isinstance(track, dict) or not isinstance(track.get('id'), str) or not track['id'] or len(track['id']) > 200 or not SAFE_AUDIO.fullmatch(str(track.get('filename', ''))):
            raise ValueError('Invalid backup track.')
        if track['id'] in ids or track['filename'] in filenames:
            raise ValueError('Backup contains duplicate track records.')
        ids.add(track['id']); filenames.add(track['filename'])
        try: archive.getinfo('media/' + track['filename'])
        except KeyError as exc: raise ValueError('Backup is missing audio for ' + str(track.get('title', 'a song'))[:100]) from exc
        for key in ('title', 'artist', 'album', 'genre', 'codec', 'source', 'source_url', 'fingerprint'):
            if track.get(key) is not None and (not isinstance(track[key], str) or len(track[key]) > 4000):
                raise ValueError('Invalid backup track ' + key + '.')
        if track.get('fingerprint') and not re.fullmatch('[a-f0-9]{64}', track['fingerprint']):
            raise ValueError('Invalid audio checksum.')
        for key in ('duration', 'plays', 'last_played', 'created', 'bitrate'):
            _number(track.get(key) or 0, key)
        if track.get('liked', 0) not in (0, 1, False, True):
            raise ValueError('Invalid backup like.')
    playlist_ids = set()
    total_members = 0
    for playlist in playlists:
        if not isinstance(playlist, dict) or not isinstance(playlist.get('id'), str) or not playlist['id'] or len(playlist['id']) > 200 or playlist['id'] in playlist_ids or not isinstance(playlist.get('tracks'), list) or not all(isinstance(i, str) for i in playlist['tracks']):
            raise ValueError('Invalid backup playlist.')
        playlist_ids.add(playlist['id'])
        total_members += len(playlist['tracks'])
        if total_members > 500000: raise ValueError('Backup has too many playlist entries.')
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get('track_id'), str):
            raise ValueError('Invalid backup listening event.')
        _number(event.get('played_at'), 'listening time')
    return dict(tracks=tracks, playlists=playlists, events=events)


def export_library(root, destination, progress=None):
    root, destination = Path(root).expanduser().resolve(), Path(destination).expanduser().resolve()
    report = progress or (lambda state: None)
    db = sqlite3.connect(f'{(root / "muso.sqlite3").as_uri()}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    created = False
    try:
        db.execute('BEGIN')
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        tracks = [dict(row) for row in db.execute('SELECT * FROM tracks')]
        playlists = [dict(row) for row in db.execute('SELECT * FROM playlists')] if 'playlists' in tables else []
        for playlist in playlists:
            playlist['tracks'] = [row[0] for row in db.execute('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position', (playlist['id'],))]
        events = [dict(row) for row in db.execute('SELECT track_id,title,artist,played_at FROM listening_events')] if 'listening_events' in tables else []
        metadata = dict(format='muso-portable-1', tracks=tracks, playlists=playlists, events=events)
        total = 0
        for track in tracks:
            if not SAFE_AUDIO.fullmatch(track['filename']): raise ValueError('Invalid library filename')
            audio = root / 'media' / track['filename']
            if not audio.is_file(): raise ValueError('Audio file missing: ' + str(track.get('title', track['filename'])))
            size = audio.stat().st_size
            if size > 512 * 1024 ** 2: raise ValueError('A song exceeds the 512 MB backup limit.')
            total += size
        metadata_bytes = json.dumps(metadata, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if total + len(metadata_bytes) > MAX_BYTES or len(metadata_bytes) > 20 * 1024 ** 2 or len(tracks) > 50000 or len(playlists) > 10000 or len(events) > 200000:
            raise ValueError('Library exceeds the portable backup limits (10 GB / 50,000 songs).')
        if total + len(metadata_bytes) + RESERVE > shutil.disk_usage(destination.parent).free:
            raise ValueError('Not enough free space to create this backup.')
        with destination.open('xb') as output:
            created = True
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                archive.writestr('muso-backup.json', metadata_bytes)
                for index, track in enumerate(tracks):
                    report(dict(completed=index, total=len(tracks), message='Backing up ' + str(track.get('title', 'Audio'))[:100]))
                    archive.write(root / 'media' / track['filename'], 'media/' + track['filename'])
        report(dict(completed=len(tracks), total=len(tracks), message='Backup created'))
    except BaseException:
        if created: destination.unlink(missing_ok=True)
        raise
    finally:
        db.close()
    return len(tracks)


def preview_library(store, source):
    with zipfile.ZipFile(source) as archive:
        metadata = _metadata(archive)
        tracks = metadata['tracks']
        with store.db() as db:
            fingerprints = {row[0] for row in db.execute('SELECT fingerprint FROM tracks')}
        size = sum(archive.getinfo('media/' + t['filename']).file_size for t in tracks)
        required = size + RESERVE
        free = shutil.disk_usage(store.root).free
        return dict(tracks=len(tracks), playlists=len(metadata['playlists']), events=len(metadata['events']),
                    liked=sum(bool(t.get('liked')) for t in tracks), matches=sum(bool(t.get('fingerprint')) and t['fingerprint'] in fingerprints for t in tracks),
                    bytes=size, requiredBytes=required, freeBytes=free, canImport=free >= required)


def import_library(store, source, progress=None):
    saved = duplicates = 0
    errors, mapped = [], {}
    report = progress or (lambda state: None)
    with zipfile.ZipFile(source) as archive:
        metadata = _metadata(archive)
        tracks, playlists, events = (metadata[key] for key in ('tracks', 'playlists', 'events'))
        needed = sum(archive.getinfo('media/' + t['filename']).file_size for t in tracks)
        if needed + RESERVE > shutil.disk_usage(store.root).free:
            raise ValueError('Not enough free space to import this backup.')
        for index, track in enumerate(tracks):
            report(dict(completed=index, total=len(tracks), saved=saved, duplicates=duplicates, message='Importing ' + str(track.get('title', 'Audio'))[:100]))
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
                               (int(bool(track.get('liked'))), int(track.get('plays') or 0), float(track.get('last_played') or 0), track_id))
            except Exception as exc:
                errors.append(f"{str(track.get('title', 'Audio'))[:100]}: {str(exc)[:150]}")
            finally:
                path.unlink(missing_ok=True)
        report(dict(completed=len(tracks), total=len(tracks), message='Restoring playlists and listening history'))
        with store.db() as db:
            for playlist in playlists:
                old = playlist['id']
                playlist_id = old if re.fullmatch('backup-[a-f0-9]{32}', old) else 'backup-' + hashlib.sha256(old.encode()).hexdigest()[:32]
                db.execute('INSERT OR IGNORE INTO playlists VALUES (?,?,?)', (playlist_id, str(playlist.get('name') or 'Imported playlist')[:80], time.time()))
                existing = [row[0] for row in db.execute('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position', (playlist_id,))]
                for old_id in playlist['tracks']:
                    track_id = mapped.get(old_id)
                    if track_id and track_id not in existing:
                        db.execute('INSERT INTO playlist_tracks VALUES (?,?,?)', (playlist_id, track_id, len(existing)))
                        existing.append(track_id)
            for event in events:
                track_id = mapped.get(event['track_id'])
                if not track_id: continue
                played_at = event['played_at']
                db.execute('''INSERT INTO listening_events(track_id,title,artist,played_at)
                    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM listening_events WHERE track_id=? AND played_at=?)''',
                    (track_id, str(event.get('title') or '')[:300], str(event.get('artist') or '')[:300], played_at, track_id, played_at))
    return dict(saved=saved, duplicates=duplicates, errors=errors)


def find_termux_library():
    """Read literal service assignments without sourcing or executing shell code."""
    for key in ('MUSO_DATA_DIR', 'MUSO_SERVICE_DATA_DIR'):
        if os.environ.get(key): return Path(os.environ[key]).expanduser()
    prefix = Path(os.environ.get('PREFIX', '/data/data/com.termux/files/usr'))
    config = prefix / 'var/service/muso/muso.conf'
    if config.is_file():
        for line in config.read_text().splitlines():
            if line.startswith('MUSO_SERVICE_DATA_DIR='):
                values = shlex.split(line.partition('=')[2])
                if len(values) == 1: return Path(values[0]).expanduser()
    return Path.home() / '.local/share/muso'


def main():
    parser = argparse.ArgumentParser(description='Copy Muso music, playlists, likes and history into a ZIP for Android. Originals stay untouched.')
    parser.add_argument('destination', nargs='?', help='optional output ZIP path')
    parser.add_argument('--data-dir', type=Path, help='custom Muso data folder containing muso.sqlite3 and media/')
    args = parser.parse_args()
    root = args.data_dir.expanduser() if args.data_dir else find_termux_library()
    downloads = Path.home() / 'storage/downloads'
    destination = Path(args.destination).expanduser() if args.destination else downloads / time.strftime('Muso-backup-%Y%m%d-%H%M%S.zip')
    if not (root / 'muso.sqlite3').is_file():
        parser.exit(1, f'Muso library not found at {root}. Use --data-dir /path/to/your/muso-data\n')
    if not destination.parent.is_dir():
        parser.exit(1, 'Downloads is unavailable. Run termux-setup-storage, allow access, then run this command again.\n')
    print(f'Library: {root}\nSaving: {destination}\nKeep Termux open until export finishes.', flush=True)
    try:
        count = export_library(root, destination, lambda state: print(f"\r{state['completed']}/{state['total']} songs copied", end='', flush=True))
    except Exception as exc:
        parser.exit(1, f'\nBackup failed: {exc}\nOriginal library is unchanged.\n')
    print(f'\nDone: {count} songs plus playlists, likes and listening history.\nOpen Muso Android → Add music → Transfer & backup → Choose backup ZIP.\nSelect {destination.name}. Original library is unchanged.')


if __name__ == '__main__':
    main()
