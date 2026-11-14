"""Find a few more recordings around the listener's favourites."""
import hashlib
import random
import re
import shutil
import unicodedata
from datetime import date

import importer


def key(value):
    value = unicodedata.normalize('NFKD', value.casefold())
    return ''.join(c for c in value if c.isalnum())


def song_key(title, artist):
    title = re.sub(r'\s*[\[(](?:official[^)\]]*|audio|lyrics?|remastered[^)\]]*)[\])]', '', title, flags=re.I)
    artist = re.sub(r'\s*(?:- Topic|VEVO|Official)$', '', artist, flags=re.I)
    return key(title), key(artist.split(',')[0])


def already_owned(db, title, artist):
    wanted = song_key(title, artist)
    return any(song_key(row['title'], row['artist']) == wanted
               for row in db.execute('SELECT title,artist FROM tracks'))


def candidate(entry):
    title, artist = entry['title'], entry['artist']
    if not 70 <= entry['duration'] <= 540:
        return None
    if re.search(r'\b(playlist|karaoke|reaction|cover|slowed|sped up|type beat|hour mix)\b', title, re.I):
        return None
    topic = artist.endswith(' - Topic')
    official = bool(re.search(r'\bofficial (?:audio|music video)\b', title, re.I))
    if not (topic or official or artist.lower().endswith('vevo')):
        return None
    artist = re.sub(r'\s*(?:- Topic|VEVO)$', '', artist, flags=re.I).strip()
    title = re.sub(r'\s*[\[(]official (?:audio|music video)[\])]\s*$', '', title, flags=re.I)
    prefix = artist + ' - '
    if title.casefold().startswith(prefix.casefold()):
        title = title[len(prefix):]
    return title, artist


def run(store, day):
    with store.db() as db:
        status = store.discovery_status(db)
        if not status['enabled'] or status['added'] >= status['limit']:
            return
        seeds = list(db.execute("""
            SELECT title,artist FROM tracks
            WHERE artist NOT IN ('Unknown artist', 'YouTube')
              AND id NOT IN (SELECT track_id FROM daily_discovery)
            ORDER BY liked DESC, plays DESC, created DESC LIMIT 60
        """))
    if not seeds:
        return
    rng = random.SystemRandom()
    seeds = rng.sample(seeds[:30], min(4, len(seeds)))
    for seed in seeds:
        artist = seed['artist'].split(',')[0].removesuffix(' - Topic')
        queries = [f"{seed['title']} {artist} similar songs official audio",
                   f"{artist} official audio"]
        for query in queries:
            with store.db() as db:
                status = store.discovery_status(db)
                if (not status['enabled'] or status['added'] >= status['limit']
                        or day != date.today().isoformat()
                        or db.execute("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1").fetchone()):
                    return
            results = importer.search(query)
            for entry in results:
                info = candidate(entry)
                if info is None:
                    continue
                title, artist_name = info
                with store.db() as db:
                    if db.execute('SELECT 1 FROM tracks WHERE source_url=?', (entry['url'],)).fetchone() or already_owned(db, title, artist_name):
                        continue
                folder = store.temp / ('discovery-' + hashlib.sha256(entry['url'].encode()).hexdigest()[:20])
                shutil.rmtree(folder, ignore_errors=True)
                try:
                    path, metadata = importer.download(entry['url'], folder)
                    metadata.update(title=title, artist=artist_name)
                    if store.add_track(path, metadata, discovery_day=day):
                        return True
                except importer.ImportFailure:
                    continue
                finally:
                    shutil.rmtree(folder, ignore_errors=True)
