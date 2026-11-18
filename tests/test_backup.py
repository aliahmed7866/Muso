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
