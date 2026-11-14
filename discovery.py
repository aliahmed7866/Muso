"""Find a few more recordings around the listener's favourites."""
import hashlib
import math
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
    artist = artist_name(artist)
    prefix = artist + ' - '
    if title.casefold().startswith(prefix.casefold()):
        title = title[len(prefix):]
    title = re.sub(r'\s*[\[(](?:official[^)\]]*|audio|lyrics?|(?:\d{4} )?remaster[^)\]]*)[\])]', '', title, flags=re.I)
    title = re.sub(r'\s+-\s+(?:official audio|(?:\d{4} )?remaster(?:ed)?)$', '', title, flags=re.I)
    return key(title), key(artist)


def artist_name(artist):
    return re.sub(r'\s*(?:- Topic|VEVO| Official)$', '', artist.split(',')[0], flags=re.I).strip()


def feedback_key(kind, title, artist):
    song, performer = song_key(title, artist)
    return performer if kind == 'artist' else f'{performer}:{song}'


def is_blocked(db, title, artist):
    return db.execute("""
        SELECT 1 FROM discovery_feedback
        WHERE (kind='artist' AND value=?) OR (kind='song' AND value=?)
    """, (feedback_key('artist', title, artist), feedback_key('song', title, artist))).fetchone()


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
    topic = artist.casefold().endswith(' - topic')
    official = bool(re.search(r'\bofficial (?:audio|music video)\b', title, re.I))
    if not (topic or official or artist.lower().endswith('vevo')):
        return None
    artist = re.sub(r'\s*(?:- Topic|VEVO)$', '', artist, flags=re.I).strip()
    title = re.sub(r'\s*[\[(]official (?:audio|music video)[\])]\s*$', '', title, flags=re.I)
    prefix = artist + ' - '
    if title.casefold().startswith(prefix.casefold()):
        title = title[len(prefix):]
    return title, artist


def seeds_for(db):
    return list(db.execute("""
        SELECT t.title,t.artist,t.genre,t.liked,t.plays,t.last_played FROM tracks AS t
        LEFT JOIN daily_discovery AS d ON t.id=d.track_id
        WHERE trim(t.artist) NOT IN ('', 'Unknown artist', 'YouTube')
          AND (d.track_id IS NULL OR t.liked=1)
        ORDER BY t.liked DESC, t.last_played DESC, t.plays DESC, t.created DESC LIMIT 200
    """))


def discovery_queries(seeds, blocked_artists, rng):
    # Select at most one seed per performer before weighting favourites.
    by_artist = {}
    for seed in seeds:
        name = artist_name(seed['artist'])
        if key(name) and key(name) not in blocked_artists:
            by_artist.setdefault(key(name), (name, seed))
    choices = sorted(by_artist.values(), key=lambda pair: rng.random() ** (
        1 / (1 + 3 * pair[1]['liked'] + math.log1p(max(0, pair[1]['plays'])))
    ), reverse=True)[:4]
    queries = []
    for artist, seed in choices:
        if seed['genre']:
            queries.append((f"{seed['genre']} {artist} similar artists official audio", artist, True))
        queries.append((f"{seed['title']} {artist} similar songs official audio", artist, True))
        queries.append((f"{artist} official audio", artist, False))
    return sorted(queries, key=lambda query: not query[2])


def run(store, day, manual=False):
    with store.db() as db:
        status = store.discovery_status(db)
        if not store.can_discover(status, manual):
            return
        seeds = seeds_for(db)
        if manual:
            selected = db.execute("""
                SELECT t.title,t.artist,t.genre,t.liked,t.plays FROM tracks t
                JOIN preferences p ON p.value=t.id WHERE p.key='discovery_seed'
            """).fetchone()
            if selected is not None:
                seeds = [selected]
        feedback = {(row['kind'], row['value']) for row in db.execute('SELECT kind,value FROM discovery_feedback')}
        recent_artists = {key(artist_name(row['artist'])) for row in db.execute("""
            SELECT t.artist FROM daily_discovery d JOIN tracks t ON d.track_id=t.id
            ORDER BY t.created DESC LIMIT 12
        """)}
    blocked_artists = {value for kind, value in feedback if kind == 'artist'}
    rng = random.SystemRandom()
    seen = set()
    for query, artist, explore in discovery_queries(seeds, blocked_artists, rng):
        with store.db() as db:
            status = store.discovery_status(db)
            if not store.can_discover(status, manual):
                return
            if (day != date.today().isoformat()
                    or db.execute("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1").fetchone()):
                return 'yield'
        matches = []
        for entry in importer.search(query):
            info = candidate(entry)
            if info is None or entry['url'] in seen:
                continue
            title, performer = info
            artist_key = key(artist_name(performer))
            if artist_key in blocked_artists or ('song', feedback_key('song', title, performer)) in feedback:
                continue
            if not explore and artist_key != key(artist):
                continue
            score = 4 * (artist_key not in recent_artists) + 2 * (explore and artist_key != key(artist))
            score += entry['artist'].endswith(' - Topic')
            matches.append((score, entry, title, performer))
        for _, entry, title, performer in sorted(matches, key=lambda match: match[0], reverse=True):
            seen.add(entry['url'])
            with store.db() as db:
                status = store.discovery_status(db)
                if not store.can_discover(status, manual):
                    return
                if (day != date.today().isoformat()
                        or db.execute("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1").fetchone()):
                    return 'yield'
                if (db.execute('SELECT 1 FROM tracks WHERE source_url=?', (entry['url'],)).fetchone()
                        or already_owned(db, title, performer)):
                    continue
            folder = store.temp / ('discovery-' + hashlib.sha256(entry['url'].encode()).hexdigest()[:20])
            shutil.rmtree(folder, ignore_errors=True)
            try:
                path, metadata = importer.download(entry['url'], folder)
                if key(metadata['title']) == key(entry['title']):
                    metadata['title'] = title
                if key(metadata['artist']) == key(entry['artist']):
                    metadata['artist'] = performer
                if store.add_track(path, metadata, discovery_day=day, manual=manual):
                    return 'saved'
            except importer.ImportFailure:
                continue
            finally:
                shutil.rmtree(folder, ignore_errors=True)
