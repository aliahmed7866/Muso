import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from app import Store
from backup import export_library, import_library


class BackupTests(unittest.TestCase):
    def test_roundtrip_preserves_music_likes_playlists_and_recap_without_duplicates(self):
        with tempfile.TemporaryDirectory() as root:
            source, target = Store(Path(root, 'source')), Store(Path(root, 'target'))
            media = source.temp / 'song.mp3'
            media.write_bytes(b'original audio bytes')
            song = source.add_track(media, dict(title='My song', artist='Artist', duration=200))
            with source.db() as db:
                db.execute('UPDATE tracks SET liked=1,plays=8,last_played=123 WHERE id=?', (song,))
                db.execute("INSERT INTO playlists VALUES ('p','Favourites',123)")
                db.execute("INSERT INTO playlist_tracks VALUES ('p',?,0)", (song,))
                db.execute("INSERT INTO listening_events(track_id,title,artist,played_at) VALUES (?,'My song','Artist',123)", (song,))
            archive = Path(root, 'muso.zip')
            self.assertEqual(1, export_library(source.root, archive))
            for index in range(2):
                result = import_library(target, archive)
                self.assertEqual([], result['errors'])
                self.assertEqual(1 - index, result['saved'])
                with target.db() as db:
                    row = db.execute('SELECT * FROM tracks').fetchone()
                    self.assertEqual(1, row['liked'])
                    self.assertEqual(8, row['plays'])
                    self.assertEqual(1, db.execute('SELECT count(*) FROM tracks').fetchone()[0])
                    self.assertEqual(1, db.execute('SELECT count(*) FROM playlists').fetchone()[0])
                    self.assertEqual(1, db.execute('SELECT count(*) FROM playlist_tracks').fetchone()[0])
                    self.assertEqual(1, db.execute('SELECT count(*) FROM listening_events').fetchone()[0])
                    self.assertEqual(b'original audio bytes', (target.media / row['filename']).read_bytes())
            self.assertTrue((source.media / next(source.media.iterdir()).name).exists())
            with self.assertRaises(FileExistsError): export_library(source.root, archive)

    def test_rejects_traversal_before_writing_library(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(Path(root, 'target'))
            archive = Path(root, 'bad.zip')
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('muso-backup.json', json.dumps(dict(format='muso-portable-1', tracks=[])))
                output.writestr('media/../../escape.mp3', b'bad')
            with self.assertRaises(ValueError): import_library(store, archive)
            self.assertEqual([], list(store.media.iterdir()))
            self.assertFalse(Path(root, 'escape.mp3').exists())

    def test_preview_validation_progress_and_repeat_after_reexport(self):
        from backup import preview_library
        with tempfile.TemporaryDirectory() as root:
            source, target = Store(Path(root, 'source')), Store(Path(root, 'target'))
            song = source.temp / 'song.mp3'; song.write_bytes(b'backup preview song')
            track_id = source.add_track(song, dict(title='Preview song', artist='Artist', duration=30))
            with source.db() as db:
                db.execute("INSERT INTO playlists VALUES ('my-list','Road trip',123)")
                db.execute("INSERT INTO playlist_tracks VALUES ('my-list',?,0)", (track_id,))
            archive = Path(root, 'original.zip'); updates = []
            export_library(source.root, archive, updates.append)
            self.assertEqual(1, updates[-1]['completed'])
            preview = preview_library(target, archive)
            self.assertEqual((1, 1, 0), (preview['tracks'], preview['playlists'], preview['matches']))
            self.assertTrue(preview['canImport'])
            self.assertEqual([], list(target.media.iterdir()), 'Preview must not import anything')
            result = import_library(target, archive, updates.append)
            self.assertEqual(1, result['saved'])
            self.assertEqual(1, preview_library(target, archive)['matches'])
            again = Path(root, 'reexport.zip'); export_library(target.root, again)
            self.assertEqual(1, import_library(target, again)['duplicates'])
            with target.db() as db:
                self.assertEqual(1, db.execute('SELECT COUNT(*) FROM playlists').fetchone()[0])

    def test_invalid_metadata_rejected_before_any_tracks_are_added(self):
        from backup import preview_library
        with tempfile.TemporaryDirectory() as root:
            source, target = Store(Path(root, 'source')), Store(Path(root, 'target'))
            song = source.temp / 'song.mp3'; song.write_bytes(b'test')
            song_id = source.add_track(song, dict(title='Song'))
            valid = Path(root, 'valid.zip'); export_library(source.root, valid)
            with zipfile.ZipFile(valid) as archive:
                metadata = json.loads(archive.read('muso-backup.json'))
                media = {n: archive.read(n) for n in archive.namelist() if n.startswith('media/')}
            for field, value in [('events', [dict(track_id=song_id, played_at=float('nan'))]), ('playlists', [dict(id='p', tracks=[{}])]), ('tracks', metadata['tracks'] * 2)]:
                with self.subTest(field=field):
                    invalid = Path(root, field + '.zip')
                    with zipfile.ZipFile(invalid, 'w') as archive:
                        archive.writestr('muso-backup.json', json.dumps({**metadata, field: value}))
                        for name, data in media.items(): archive.writestr(name, data)
                    with self.assertRaises(ValueError): preview_library(target, invalid)
                    with self.assertRaises(ValueError): import_library(target, invalid)
                    self.assertEqual([], list(target.media.iterdir()))

    def test_failed_audio_can_retry_without_losing_successful_imports(self):
        with tempfile.TemporaryDirectory() as root:
            source, target = Store(Path(root, 'source')), Store(Path(root, 'target'))
            for i in range(2):
                path = source.temp / f'song{i}.mp3'; path.write_bytes(f'song {i}'.encode())
                source.add_track(path, dict(title=f'Song {i}'))
            valid = Path(root, 'good.zip'); export_library(source.root, valid)
            corrupt = Path(root, 'corrupt.zip')
            with zipfile.ZipFile(valid) as input_file, zipfile.ZipFile(corrupt, 'w') as output:
                names = input_file.namelist()
                for name in names: output.writestr(name, b'corrupted' if name == names[-1] else input_file.read(name))
            result = import_library(target, corrupt)
            self.assertEqual((1, 1), (result['saved'], len(result['errors'])))
            result = import_library(target, valid)
            self.assertEqual((1, 1, []), (result['saved'], result['duplicates'], result['errors']))

    def test_standalone_cli_detects_service_data_and_preserves_existing_destination(self):
        import os
        import shlex
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as root:
            home, prefix = Path(root, 'home'), Path(root, 'usr')
            downloads = home / 'storage/downloads'; downloads.mkdir(parents=True)
            source = Store(home / 'Custom music')
            song = source.temp / 'song.mp3'; song.write_bytes(b'cli original')
            source.add_track(song, dict(title='CLI song'))
            config = prefix / 'var/service/muso/muso.conf'; config.parent.mkdir(parents=True)
            config.write_text('MUSO_SERVICE_DATA_DIR=' + shlex.quote(str(source.root)) + '\n')
            tool = downloads / 'Muso-transfer.py'; tool.write_bytes(Path(__file__).resolve().parents[1].joinpath('backup.py').read_bytes())
            env = {k:v for k,v in os.environ.items() if k not in ('MUSO_DATA_DIR','MUSO_SERVICE_DATA_DIR')}
            env.update(HOME=str(home), PREFIX=str(prefix))
            result = subprocess.run([sys.executable, str(tool)], cwd=downloads, env=env, capture_output=True, text=True)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn('Done: 1 songs', result.stdout)
            output = next(downloads.glob('Muso-backup-*.zip')); original = output.read_bytes()
            result = subprocess.run([sys.executable, str(tool), str(output)], env=env, capture_output=True, text=True)
            self.assertNotEqual(0, result.returncode)
            self.assertEqual(original, output.read_bytes())
            self.assertTrue(any(source.media.iterdir()))
