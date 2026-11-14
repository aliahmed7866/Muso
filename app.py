"""Muso: a phone-owned music library served only on loopback."""
import fcntl
import hashlib
import json
import logging
import os
import secrets
import shutil
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, abort, jsonify, render_template, request, send_file
from werkzeug.exceptions import HTTPException
import mutagen
import importer
import discovery

SCHEMA = '''
CREATE TABLE IF NOT EXISTS tracks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL DEFAULT '',
 duration REAL NOT NULL DEFAULT 0, filename TEXT NOT NULL, source TEXT NOT NULL,
 source_url TEXT UNIQUE, fingerprint TEXT UNIQUE, liked INTEGER NOT NULL DEFAULT 0,
 plays INTEGER NOT NULL DEFAULT 0, last_played REAL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_tracks (
 playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,
 track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL,
 PRIMARY KEY (playlist_id, track_id));
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, url TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL,
 title TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', candidates TEXT NOT NULL DEFAULT '[]',
 selected_url TEXT, track_id TEXT, created REAL NOT NULL, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created);
CREATE TABLE IF NOT EXISTS daily_discovery (
 day TEXT NOT NULL, track_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS listening_events (
 id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, title TEXT NOT NULL,
 artist TEXT NOT NULL, played_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS listening_events_month ON listening_events(played_at);
CREATE TABLE IF NOT EXISTS discovery_requests (
 id INTEGER PRIMARY KEY CHECK (id=1), status TEXT NOT NULL,
 added INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '');
'''


class Store:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.media = self.root / 'media'
        self.media.mkdir(exist_ok=True)
        self.temp = self.root / 'imports'
        self.temp.mkdir(exist_ok=True)
        with self.db() as db:
            db.executescript(SCHEMA)
        token_path = self.root / 'token'
        if not token_path.exists():
            try:
                with open(token_path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
                    f.write(secrets.token_urlsafe(32))
            except FileExistsError:
                pass
        self.token = token_path.read_text().strip()

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.root / 'muso.sqlite3', timeout=20)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA journal_mode=WAL')
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def update_job(self, job_id, **fields):
        fields['updated'] = time.time()
        with self.db() as db:
            db.execute('UPDATE jobs SET ' + ','.join(k + '=?' for k in fields) + ' WHERE id=?', [*fields.values(), job_id])

    def add_track(self, path, metadata, discovery_day=None, manual=False):
        path = Path(path)
        digest = hashlib.sha256()
        with path.open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                digest.update(chunk)
        fingerprint = digest.hexdigest()
        source_url = metadata.get('source_url') or None
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if discovery_day:
                status = self.discovery_status(db)
                if discovery_day != date.today().isoformat() or not self.can_discover(status, manual):
                    return None
            existing = db.execute('SELECT id FROM tracks WHERE fingerprint=? OR source_url=?', (fingerprint, source_url)).fetchone()
            if existing:
                path.unlink(missing_ok=True)
                return None if discovery_day else existing['id']
            if discovery_day and discovery.already_owned(db, metadata['title'], metadata['artist']):
                return None
            track_id = uuid.uuid4().hex
            filename = track_id + path.suffix.lower()
            target = self.media / filename
            shutil.move(str(path), target)
            try:
                db.execute('INSERT INTO tracks (id,title,artist,album,duration,filename,source,source_url,fingerprint,created) VALUES (?,?,?,?,?,?,?,?,?,?)', (track_id, str(metadata.get('title') or 'Untitled')[:300], str(metadata.get('artist') or 'Unknown artist')[:300], str(metadata.get('album') or '')[:300], float(metadata.get('duration') or 0), filename, metadata.get('source', 'local'), source_url, fingerprint, time.time()))
                if discovery_day:
                    db.execute('INSERT INTO daily_discovery VALUES (?,?)', (discovery_day, track_id))
                    if manual:
                        db.execute('UPDATE discovery_requests SET added=added+1 WHERE id=1')
            except Exception:
                target.unlink(missing_ok=True)
                raise
        return track_id

    def process_one(self):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if not row:
                return False
            job = dict(row)
            db.execute("UPDATE jobs SET status='working',message='Connecting to source…',updated=? WHERE id=?", (time.time(), job['id']))
        folder = self.temp / job['id']
        try:
            if job['provider'] == 'spotify' and not job['selected_url']:
                title = importer.spotify_title(job['url'])
                self.update_job(job['id'], title=title, message='Finding versions on YouTube…')
                try:
                    matches = importer.search(title + ' audio')
                    message = 'Choose the right recording, or refine the search.'
                except importer.ImportFailure:
                    matches = []
                    message = 'Automatic search failed. Search again or paste a YouTube match.'
                self.update_job(job['id'], status='needs_match', candidates=json.dumps(matches), message=message)
            else:
                self.update_job(job['id'], message='Saving audio to your phone…')
                path, metadata = importer.download(job['selected_url'] or job['url'], folder)
                track_id = self.add_track(path, metadata)
                self.update_job(job['id'], status='done', track_id=track_id, title=metadata['title'], message='Ready to play offline')
        except Exception as exc:
            self.update_job(job['id'], status='failed', message=str(exc)[:700])
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        return True

    def discovery_status(self, db):
        setting = db.execute("SELECT value FROM preferences WHERE key='discovery'").fetchone()
        added = db.execute('SELECT count(*) FROM daily_discovery WHERE day=?', (date.today().isoformat(),)).fetchone()[0]
        manual = db.execute('SELECT status,added,message FROM discovery_requests WHERE id=1').fetchone()
        return dict(enabled=not setting or setting[0] == '1', added=added, limit=5,
                    manual=dict(manual) if manual else dict(status='idle', added=0, message=''))

    @staticmethod
    def can_discover(status, manual):
        if manual:
            request = status['manual']
            return request['status'] == 'running' and request['added'] < status['limit']
        return status['enabled'] and status['added'] < status['limit']

    def process_discovery_request(self, day):
        with self.db() as db:
            row = db.execute("SELECT added FROM discovery_requests WHERE status='queued'").fetchone()
            if row is None:
                return False
            db.execute("UPDATE discovery_requests SET status='running' WHERE id=1")
        try:
            outcome = discovery.run(self, day, manual=True)
            with self.db() as db:
                status = self.discovery_status(db)
                added = status['manual']['added']
                more = added < status['limit'] and outcome in ('saved', 'yield')
                message = '' if more else ('Batch complete.' if added >= status['limit'] else
                                           'No more suitable matches found in this batch.')
                db.execute('UPDATE discovery_requests SET status=?,message=? WHERE id=1',
                           ('queued' if more else 'done', message))
        except Exception:
            logging.getLogger(__name__).exception('Requested discovery failed')
            with self.db() as db:
                db.execute("UPDATE discovery_requests SET status='failed',message=? WHERE id=1",
                           ('The search or download failed. Check your connection and try again.',))
        return True

    def worker(self):
        with self.db() as db:
            db.execute("UPDATE jobs SET status='queued',message='Resuming after restart…' WHERE status='working'")
            db.execute("UPDATE discovery_requests SET status='queued' WHERE status='running'")
        last_day, next_attempt = '', 0
        while True:
            if self.process_one():
                continue
            day = date.today().isoformat()
            if self.process_discovery_request(day):
                continue
            if day != last_day or time.monotonic() >= next_attempt:
                last_day, next_attempt = day, time.monotonic() + 1800
                try:
                    if discovery.run(self, day) == 'saved':
                        next_attempt = time.monotonic() + 15
                except Exception:
                    logging.getLogger(__name__).exception('Daily discovery failed')
            time.sleep(1)


def create_app(data_dir=None):
    app = Flask(__name__)
    app.config.update(MAX_CONTENT_LENGTH=512 * 1024 * 1024)
    store = Store(data_dir or os.environ.get('MUSO_DATA_DIR', '~/.local/share/muso'))
    app.extensions['store'] = store

    @app.before_request
    def guard():
        host = urlsplit('http://' + request.host).hostname
        if host not in ('127.0.0.1', 'localhost', '[::1]', '::1'):
            abort(403, 'Muso only accepts localhost requests.')
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            if not secrets.compare_digest(request.headers.get('X-Muso-Token', ''), store.token):
                abort(403, 'Reload Muso and try again.')
            origin = request.headers.get('Origin')
            if origin and origin != request.host_url.rstrip('/'):
                abort(403, 'Cross-site requests are blocked.')

    @app.after_request
    def headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        if request.path.startswith('/api/') or request.path == '/':
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(importer.ImportFailure)
    def import_error(error):
        return jsonify(error=str(error)), 400

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            abort(400, 'Expected a JSON object.')
        return data

    def text_field(data, key, max_len=300):
        value = data.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > max_len:
            abort(400, 'Enter a valid ' + key + '.')
        return value.strip()

    def track_exists(db, track_id):
        row = db.execute('SELECT * FROM tracks WHERE id=?', (track_id,)).fetchone()
        if not row:
            abort(404, 'Track not found.')
        return row

    def set_playlist_tracks(db, playlist_id, ids):
        if (not isinstance(ids, list) or len(ids) > 10000
                or any(not isinstance(item, str) for item in ids) or len(set(ids)) != len(ids)):
            abort(400, 'Expected a list of unique track IDs.')
        for track_id in ids:
            track_exists(db, track_id)
        db.execute('DELETE FROM playlist_tracks WHERE playlist_id=?', (playlist_id,))
        db.executemany('INSERT INTO playlist_tracks VALUES (?,?,?)',
                       [(playlist_id, track_id, position) for position, track_id in enumerate(ids)])

    @app.get('/')
    def index():
        return render_template('index.html', token=store.token)

    @app.get('/sw.js')
    def service_worker():
        return send_file(Path(app.static_folder) / 'sw.js', mimetype='text/javascript', max_age=0)

    @app.get('/api/health')
    def health():
        return jsonify(ok=True, app='Muso', version='1.0.0')

    @app.get('/api/library')
    def library():
        with store.db() as db:
            tracks = [dict(r) for r in db.execute("""
                SELECT t.id,t.title,t.artist,t.album,t.duration,t.source,t.source_url,
                       t.liked,t.plays,t.last_played,t.created,d.day AS discovered_on
                FROM tracks AS t LEFT JOIN daily_discovery AS d ON d.track_id=t.id
                ORDER BY t.created DESC
            """)]
            playlists = [dict(r) for r in db.execute('SELECT * FROM playlists ORDER BY created')]
            for playlist in playlists:
                playlist['tracks'] = [r[0] for r in db.execute('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position', (playlist['id'],))]
            discovery_status = store.discovery_status(db)
        return jsonify(tracks=tracks, playlists=playlists, discovery=discovery_status)

    @app.get('/api/discovery')
    def get_discovery():
        with store.db() as db:
            return jsonify(store.discovery_status(db))

    @app.post('/api/discovery/run')
    def request_discovery():
        with store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            status = store.discovery_status(db)
            if status['manual']['status'] in ('queued', 'running'):
                return jsonify(status), 202
            if not discovery.seeds_for(db):
                abort(409, 'Add a song with a known artist before running discovery.')
            db.execute("INSERT OR REPLACE INTO discovery_requests VALUES (1,'queued',0,'')")
            return jsonify(store.discovery_status(db)), 202

    @app.patch('/api/discovery')
    def update_discovery():
        enabled = body().get('enabled')
        if not isinstance(enabled, bool):
            abort(400, 'enabled must be true or false.')
        with store.db() as db:
            db.execute("INSERT OR REPLACE INTO preferences VALUES ('discovery',?)", ('1' if enabled else '0',))
            return jsonify(store.discovery_status(db))

    @app.get('/api/stats')
    def stats():
        size = sum(p.stat().st_size for p in store.media.iterdir() if p.is_file())
        return jsonify(bytes=size, free_bytes=shutil.disk_usage(store.root).free, data_dir=str(store.root))

    @app.get('/api/tracks/<track_id>/audio')
    def audio(track_id):
        with store.db() as db:
            row = track_exists(db, track_id)
        path = store.media / row['filename']
        if not path.is_file():
            abort(404, 'The audio file is missing. Import it again.')
        mime = {'.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac'}.get(path.suffix)
        return send_file(path, mimetype=mime, conditional=True)

    @app.patch('/api/tracks/<track_id>')
    def update_track(track_id):
        data = body()
        fields = {}
        for key in ('title', 'artist', 'album'):
            if key in data:
                fields[key] = text_field(data, key)
        if 'liked' in data:
            if not isinstance(data['liked'], bool):
                abort(400, 'liked must be true or false.')
            fields['liked'] = int(data['liked'])
        with store.db() as db:
            track_exists(db, track_id)
            if fields:
                db.execute('UPDATE tracks SET ' + ','.join(k + '=?' for k in fields) + ' WHERE id=?', [*fields.values(), track_id])
        return jsonify(ok=True)

    @app.post('/api/tracks/<track_id>/played')
    def played(track_id):
        with store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            track = track_exists(db, track_id)
            now = time.time()
            db.execute('UPDATE tracks SET plays=plays+1,last_played=? WHERE id=?', (now, track_id))
            db.execute('INSERT INTO listening_events (track_id,title,artist,played_at) VALUES (?,?,?,?)',
                       (track_id, track['title'], track['artist'], now))
        return jsonify(ok=True)

    @app.get('/api/recap')
    def recap():
        month = request.args.get('month', date.today().strftime('%Y-%m'))
        try:
            start = datetime.strptime(month, '%Y-%m')
            if start.strftime('%Y-%m') != month:
                raise ValueError
            end = start.replace(year=start.year + (start.month == 12), month=start.month % 12 + 1)
            bounds = (start.timestamp(), end.timestamp())
        except (ValueError, OverflowError, OSError):
            abort(400, 'Use a month in YYYY-MM format.')
        with store.db() as db:
            db.execute('BEGIN')
            totals = dict(db.execute("""
                SELECT count(*) AS plays, count(DISTINCT track_id) AS songs,
                       count(DISTINCT artist COLLATE NOCASE) AS artists
                FROM listening_events WHERE played_at>=? AND played_at<?
            """, bounds).fetchone())
            top_tracks = [dict(row) for row in db.execute("""
                SELECT e.track_id AS id, coalesce(t.title,max(e.title)) AS title,
                       coalesce(t.artist,max(e.artist)) AS artist, count(*) AS plays,
                       t.id IS NOT NULL AS available
                FROM listening_events AS e LEFT JOIN tracks AS t ON e.track_id=t.id
                WHERE e.played_at>=? AND e.played_at<?
                GROUP BY e.track_id ORDER BY plays DESC, title COLLATE NOCASE, e.track_id LIMIT 10
            """, bounds)]
            top_artists = [dict(row) for row in db.execute("""
                SELECT min(artist) AS artist,count(*) AS plays FROM listening_events
                WHERE played_at>=? AND played_at<? GROUP BY artist COLLATE NOCASE
                ORDER BY plays DESC, artist COLLATE NOCASE LIMIT 5
            """, bounds)]
        return jsonify(**totals, month=month, top_tracks=top_tracks, top_artists=top_artists)

    @app.delete('/api/tracks/<track_id>')
    def delete_track(track_id):
        with store.db() as db:
            row = track_exists(db, track_id)
            db.execute('DELETE FROM tracks WHERE id=?', (track_id,))
        (store.media / row['filename']).unlink(missing_ok=True)
        return jsonify(ok=True)

    @app.post('/api/upload')
    def upload():
        upload = request.files.get('file')
        if not upload or not upload.filename:
            abort(400, 'Choose an audio file.')
        ext = Path(upload.filename).suffix.lower()
        if ext not in {'.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac'}:
            abort(400, 'Supported audio: MP3, M4A, FLAC, WAV, OGG, Opus, AAC.')
        path = store.temp / (uuid.uuid4().hex + ext)
        try:
            upload.save(path)
            try:
                audio_file = mutagen.File(path, easy=True)
            except Exception:
                audio_file = None
            if audio_file is None or not getattr(audio_file, 'info', None):
                abort(400, 'This file is not readable audio.')
            tags = audio_file.tags or {}
            metadata = dict(title=(tags.get('title') or [Path(upload.filename).stem])[0], artist=(tags.get('artist') or ['Unknown artist'])[0], album=(tags.get('album') or [''])[0], duration=audio_file.info.length, source='local')
            track_id = store.add_track(path, metadata)
        finally:
            path.unlink(missing_ok=True)
        return jsonify(id=track_id), 201

    @app.post('/api/playlists')
    def create_playlist():
        data = body()
        name = text_field(data, 'name', 80)
        playlist_id = uuid.uuid4().hex
        with store.db() as db:
            db.execute('INSERT INTO playlists VALUES (?,?,?)', (playlist_id, name, time.time()))
            if 'tracks' in data:
                set_playlist_tracks(db, playlist_id, data['tracks'])
        return jsonify(id=playlist_id), 201

    @app.route('/api/playlists/<playlist_id>', methods=['PATCH', 'DELETE'])
    def playlist(playlist_id):
        with store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT id FROM playlists WHERE id=?', (playlist_id,)).fetchone():
                abort(404, 'Playlist not found.')
            if request.method == 'DELETE':
                db.execute('DELETE FROM playlists WHERE id=?', (playlist_id,))
            else:
                data = body()
                if 'expected_tracks' in data:
                    current = [r[0] for r in db.execute('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position', (playlist_id,))]
                    if current != data['expected_tracks']:
                        abort(409, 'This playlist changed. Reopen the editor and try again.')
                if 'name' in data:
                    db.execute('UPDATE playlists SET name=? WHERE id=?', (text_field(data, 'name', 80), playlist_id))
                if 'tracks' in data:
                    set_playlist_tracks(db, playlist_id, data['tracks'])
        return jsonify(ok=True)

    @app.get('/api/jobs')
    def jobs():
        with store.db() as db:
            rows = [dict(r) for r in db.execute("SELECT * FROM jobs WHERE status != 'done' OR created > ? ORDER BY created DESC LIMIT 100", (time.time() - 7 * 86400,))]
        for row in rows:
            row['candidates'] = json.loads(row['candidates'])
        return jsonify(jobs=rows)

    @app.post('/api/import')
    def import_link():
        provider, url = importer.normalize_link(text_field(body(), 'url', 2000))
        with store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute("SELECT id FROM jobs WHERE url=? AND status IN ('queued','working','needs_match')", (url,)).fetchone()
            if existing:
                return jsonify(id=existing['id']), 200
            track = db.execute('SELECT id FROM tracks WHERE source_url=?', (url,)).fetchone()
            if track:
                return jsonify(track_id=track['id'], message='Already in your library'), 200
            job_id = uuid.uuid4().hex
            db.execute('INSERT INTO jobs (id,url,provider,status,created,updated) VALUES (?,?,?,?,?,?)', (job_id, url, provider, 'queued', time.time(), time.time()))
        return jsonify(id=job_id), 202

    @app.post('/api/jobs/<job_id>/retry')
    def retry(job_id):
        with store.db() as db:
            result = db.execute("UPDATE jobs SET status='queued',message='',updated=? WHERE id=? AND status='failed'", (time.time(), job_id))
            if not result.rowcount:
                abort(409, 'Only failed imports can be retried.')
        return jsonify(ok=True)

    @app.post('/api/jobs/<job_id>/match')
    def match(job_id):
        provider, url = importer.normalize_link(text_field(body(), 'url', 2000))
        if provider != 'youtube':
            abort(400, 'Choose a YouTube recording.')
        with store.db() as db:
            result = db.execute("UPDATE jobs SET selected_url=?,status='queued',updated=? WHERE id=? AND status='needs_match'", (url, time.time(), job_id))
            if not result.rowcount:
                abort(409, 'This import is not waiting for a match.')
        return jsonify(ok=True)

    @app.delete('/api/jobs/<job_id>')
    def dismiss(job_id):
        with store.db() as db:
            result = db.execute("DELETE FROM jobs WHERE id=? AND status!='working'", (job_id,))
            if not result.rowcount:
                abort(409, 'Wait for the running import to finish.')
        return jsonify(ok=True)

    search_lock = threading.Lock()

    @app.post('/api/search')
    def search():
        query = text_field(body(), 'query', 160)
        if not search_lock.acquire(blocking=False):
            abort(429, 'A search is already running. Please wait.')
        try:
            return jsonify(results=importer.search(query))
        finally:
            search_lock.release()

    return app


def main():
    from waitress import serve
    app = create_app()
    store = app.extensions['store']
    lock = (store.root / 'server.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Muso is already running for this library.')
    threading.Thread(target=store.worker, daemon=True).start()
    port = int(os.environ.get('MUSO_PORT', '8765'))
    print(f'Muso is ready at http://127.0.0.1:{port}', flush=True)
    serve(app, host='127.0.0.1', port=port, threads=8, max_request_body_size=512 * 1024 * 1024)


if __name__ == '__main__':
    main()
