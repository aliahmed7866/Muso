import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'android-app/app/src/main/python'))
import android_backend
import importer


class AndroidBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patch = patch.multiple(importer, search=importer.search, download=importer.download)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        android_backend._web = None
        android_backend.start(self.temp.name, str(ROOT), worker=False)

    def api(self, path, method='GET', body=None):
        return json.loads(android_backend.api('/api/' + path, method, json.dumps(body) if body is not None else ''))

    def audio(self, name='test.wav'):
        path = Path(self.temp.name, 'imports', name)
        with wave.open(str(path), 'wb') as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(8000)
            output.writeframes(b'\0\0' * 8000)
        return json.loads(android_backend.import_file(str(path), name))

    def test_library_playlist_duplicate_and_recap_in_process(self):
        saved = self.audio()
        duplicate = self.audio('copy.wav')
        self.assertEqual(saved['id'], duplicate['id'])
        self.assertTrue(duplicate['duplicate'])
        library = self.api('library')['data']
        self.assertEqual(1, len(library['tracks']))
        self.assertFalse(library['discovery']['enabled'])
        self.assertEqual(201, self.api('playlists', 'POST', dict(name='Phone playlist', tracks=[saved['id']]))['status'])
        self.assertEqual(200, self.api('tracks/' + saved['id'], 'PATCH', dict(liked=True))['status'])
        android_backend.played(saved['id'])
        self.assertEqual(200, self.api('recap?month=2026-11')['status'])
        items = json.loads(android_backend.items(json.dumps([saved['id'], 'missing'])))
        self.assertEqual(1, len(items))
        self.assertTrue(Path(items[0]['path']).is_file())
        mime, html = android_backend.asset('/')
        self.assertEqual('text/html', mime)
        self.assertIn(b'/static/android.js', html)
        self.assertIn(b'Recap', html)

    def test_bridge_and_import_boundaries(self):
        for path in ['/api/../token', '/etc/passwd', '/api/tracks/a/audio', '/api/upload']:
            with self.assertRaises(ValueError):
                android_backend.api(path, 'GET', '')
        for path in ['/api/library', '/static/../../token', '/static/../app.py', 'https://example.com']:
            with self.assertRaises(ValueError):
                android_backend.asset(path)
        outside = Path(self.temp.name, 'outside.wav')
        outside.write_bytes(b'not audio')
        with self.assertRaises(ValueError):
            android_backend.import_file(str(outside), outside.name)
        self.assertTrue(outside.exists())

    def test_missing_audio_is_not_sent_to_native_player(self):
        saved = self.audio()
        items = json.loads(android_backend.items(json.dumps([saved['id']])))
        Path(items[0]['path']).unlink()
        self.assertEqual('[]', android_backend.items(json.dumps([saved['id']])))

    def test_backup_export_preview_import_and_location_boundary(self):
        self.audio()
        folder = Path(self.temp.name, 'transfers'); folder.mkdir()
        archive = folder / 'test.zip'
        class Observer:
            def __init__(self): self.progress = []
            def report(self, state): self.progress.append(json.loads(state))
        observer = Observer()
        self.assertEqual(1, json.loads(android_backend.export_backup(str(archive), observer))['tracks'])
        preview = json.loads(android_backend.preview_backup(str(archive)))
        self.assertEqual((1, 1), (preview['tracks'], preview['matches']))
        result = json.loads(android_backend.import_backup(str(archive), observer))
        self.assertEqual((0, 1, []), (result['saved'], result['duplicates'], result['errors']))
        self.assertTrue(observer.progress)
        self.assertTrue(archive.exists(), 'Native transfer manager owns staged archive lifetime')
        with self.assertRaises(ValueError): android_backend.preview_backup(str(Path(self.temp.name, 'outside.zip')))


if __name__ == '__main__':
    unittest.main()
