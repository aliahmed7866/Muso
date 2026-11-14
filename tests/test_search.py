"""Search stays responsive and exposes useful failures without live YouTube calls."""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
import importer


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = create_app(self.temp.name)
        self.client = self.app.test_client()
        self.headers = {'X-Muso-Token': self.app.extensions['store'].token}

    def start(self, query='Song Artist'):
        return self.client.post('/api/search/tasks', json={'query': query}, headers=self.headers)

    def done(self, task_id):
        for _ in range(200):
            data = self.client.get('/api/search/tasks/' + task_id).get_json()
            if data['status'] != 'running':
                return data
            time.sleep(.01)
        self.fail('Search worker never finished')

    def test_slow_search_does_not_hold_http_request_and_reuses_running_query(self):
        release = threading.Event()
        entered = threading.Event()
        result = [{'title': 'Song', 'artist': 'Artist', 'duration': 180,
                   'url': 'https://www.youtube.com/watch?v=abcdefghijk'}]
        def slow_search(query):
            entered.set()
            self.assertTrue(release.wait(5))
            return result
        with patch('importer.search', side_effect=slow_search) as search:
            task_id = None
            try:
                response = self.start()
                self.assertEqual(response.status_code, 202)
                task_id = response.json['id']
                self.assertTrue(entered.wait(1))
                self.assertEqual(self.client.get('/api/search/tasks/' + task_id).json['status'], 'running')
                self.assertEqual(self.start().json['id'], task_id)
                self.assertEqual(self.start('Another song').status_code, 429)
                self.assertEqual(self.client.post('/api/search', json={'query': 'Legacy'}, headers=self.headers).status_code, 429)
                self.assertEqual(self.client.get('/api/library').status_code, 200)
                self.assertEqual(self.client.get('/api/health').status_code, 200)
                self.assertEqual(search.call_count, 1)
            finally:
                release.set()
                if task_id:
                    self.assertEqual(self.done(task_id), {'status': 'done', 'results': result})

    def test_provider_failure_is_retained_and_retry_can_succeed(self):
        with patch('importer.search', side_effect=importer.ImportFailure('YouTube timed out. Retry.')):
            task_id = self.start().json['id']
            self.assertEqual(self.done(task_id), {'status': 'failed', 'error': 'YouTube timed out. Retry.'})
        with patch('importer.search', return_value=[]):
            retry = self.start()
            self.assertEqual(retry.status_code, 202)
            self.assertNotEqual(retry.json['id'], task_id)
            self.assertEqual(self.done(retry.json['id']), {'status': 'done', 'results': []})

    def test_search_validation_auth_and_expired_task(self):
        self.assertEqual(self.client.post('/api/search/tasks', json={'query': 'Song'}).status_code, 403)
        for query in ['', ' ' * 5, 42, 'x' * 161]:
            self.assertEqual(self.start(query).status_code, 400)
        response = self.client.get('/api/search/tasks/missing')
        self.assertEqual(response.status_code, 404)
        self.assertIn('restarted', response.json['error'])

    def test_completed_results_are_bounded_and_legacy_endpoint_still_works(self):
        with patch('importer.search', return_value=[]):
            oldest = self.start().json['id']
            self.done(oldest)
            for index in range(17):
                self.done(self.start(str(index)).json['id'])
            self.assertEqual(self.client.get('/api/search/tasks/' + oldest).status_code, 404)
            response = self.client.post('/api/search', json={'query': 'Legacy'}, headers=self.headers)
            self.assertEqual(response.json, {'results': []})

    def test_manual_discovery_preserves_provider_error(self):
        store = self.app.extensions['store']
        with store.db() as db:
            db.execute("INSERT INTO discovery_requests VALUES (1,'queued',0,'')")
        with patch('discovery.run', side_effect=importer.ImportFailure('Source unavailable: update downloader')):
            with self.assertLogs(level='ERROR'):
                store.process_discovery_request('2026-11-14')
        with store.db() as db:
            status = store.discovery_status(db)['manual']
        self.assertEqual(status['status'], 'failed')
        self.assertEqual(status['message'], 'Source unavailable: update downloader')

    def test_malformed_provider_json_is_actionable(self):
        for raw in ['not json', 'null', '{"entries": null}']:
            with patch('importer.ytdlp', return_value=raw):
                with self.assertRaisesRegex(importer.ImportFailure, 'unreadable search result'):
                    importer.search('Song Artist')


if __name__ == '__main__':
    unittest.main()
