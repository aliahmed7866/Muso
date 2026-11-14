"""Provider adapters. No credentials, DRM bypass, or paid API keys."""
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path


class ImportFailure(ValueError):
    pass


def normalize_link(text):
    match = re.search(r"https?://[^\s<>]+", str(text))
    if not match:
        raise ImportFailure("Paste a YouTube, Spotify track, or SoundCloud link.")
    raw = match.group().rstrip('.,);!\"')
    try:
        url = urllib.parse.urlsplit(raw)
        port = url.port
    except ValueError as exc:
        raise ImportFailure('This link is not supported.') from exc
    host = (url.hostname or '').lower()
    if url.username or url.password or port not in (None, 80, 443):
        raise ImportFailure("This link is not supported.")
    path = url.path.strip('/')
    if host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'):
        parts = path.split('/')
        video = parts[0] if host == 'youtu.be' else (parts[1] if parts[0] in ('shorts', 'embed', 'live') and len(parts) > 1 else urllib.parse.parse_qs(url.query).get('v', [''])[0])
        if not re.fullmatch(r'[\w-]{11}', video, re.ASCII):
            raise ImportFailure("Use a link to an individual YouTube video, not a playlist.")
        return 'youtube', 'https://www.youtube.com/watch?v=' + video
    if host in ('open.spotify.com', 'www.open.spotify.com'):
        parts = path.split('/')
        if parts[0].startswith('intl-'):
            parts = parts[1:]
        if len(parts) != 2 or parts[0] != 'track' or not re.fullmatch(r'[A-Za-z0-9]{22}', parts[1]):
            raise ImportFailure("Share an individual Spotify song. Albums and playlists are not supported yet.")
        return 'spotify', 'https://open.spotify.com/track/' + parts[1]
    if host in ('soundcloud.com', 'www.soundcloud.com') and len(path.split('/')) == 2 and not path.startswith(('discover/', 'search/')):
        return 'soundcloud', 'https://soundcloud.com/' + path
    raise ImportFailure("Use a full youtube.com, youtu.be, open.spotify.com/track, or soundcloud.com/artist/song link. Open shortened Spotify/SoundCloud links first.")


def ytdlp(args, timeout=120):
    command = [sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-plugin-dirs', '--no-warnings', '--no-colors', '--socket-timeout', '20', '--retries', '2', '--js-runtimes', 'node', *args]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise ImportFailure("The source timed out. Retry when your connection is stable.") from exc
    if result.returncode:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'Source unavailable.'
        raise ImportFailure((detail[:500] + ' Try updating the downloader using the README.'))
    return result.stdout


def search(query):
    query = str(query).strip()[:160]
    if not query:
        raise ImportFailure("Enter a song and artist to search.")
    raw = ytdlp(['--flat-playlist', '--dump-single-json', '--playlist-end', '6', '--', 'ytsearch6:' + query])
    data = json.loads(raw)
    return [dict(title=e.get('title') or 'Untitled', artist=e.get('uploader') or e.get('channel') or 'YouTube', duration=e.get('duration') or 0, url='https://www.youtube.com/watch?v=' + e['id']) for e in data.get('entries', []) if e and re.fullmatch(r'[\w-]{11}', e.get('id', ''), re.ASCII)]


def spotify_title(url):
    endpoint = 'https://open.spotify.com/oembed?' + urllib.parse.urlencode({'url': url})
    request = urllib.request.Request(endpoint, headers={'User-Agent': 'Muso/1.0'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read(1_000_000))
        return data['title'][:200]
    except Exception as exc:
        raise ImportFailure("Spotify could not identify this song. Search by song and artist in Discover instead.") from exc


def download(url, folder):
    provider, canonical = normalize_link(url)
    if provider == 'spotify':
        raise ImportFailure("Choose a YouTube match first.")
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    raw = ytdlp([
        '--no-playlist', '--max-filesize', '500M', '--match-filter', '!is_live & duration <= 3600',
        '-f', 'bestaudio/best', '--no-progress', '--no-simulate',
        '--print', 'after_move:%()j', '-o', str(folder / 'source.%(ext)s'), '--', canonical
    ], timeout=900)
    records = [json.loads(line) for line in raw.splitlines() if line.startswith('{')]
    if not records:
        raise ImportFailure("No downloadable audio. Live streams and items over one hour are excluded.")
    info = records[-1]
    files = [p for p in folder.glob('source.*') if p.suffix.lower() == '.' + str(info.get('ext', '')).lower()]
    if len(files) != 1 or not files[0].stat().st_size:
        raise ImportFailure("The source did not produce a playable audio file.")
    path = preserve_audio(files[0], info)
    return path, dict(title=info.get('track') or info.get('title') or 'Untitled',
                      artist=info.get('artist') or info.get('uploader') or 'Unknown artist',
                      album=info.get('album') or '', genre=info.get('genre') or '',
                      duration=info.get('duration') or 0, source=provider, source_url=canonical,
                      codec=str(info.get('acodec') or '').split('.')[0],
                      bitrate=round(info.get('abr') or 0))


def preserve_audio(path, info):
    """Keep audio-only streams as delivered. Strip any video without encoding."""
    supported = {'.mp3', '.m4a', '.opus', '.ogg', '.flac', '.wav', '.webm', '.aac'}
    if info.get('vcodec') == 'none' and path.suffix.lower() in supported:
        return path
    codec = str(info.get('acodec') or '').split('.')[0]
    container = {'mp4a': 'm4a', 'aac': 'm4a', 'opus': 'opus', 'vorbis': 'ogg',
                 'mp3': 'mp3', 'flac': 'flac'}.get(codec)
    if not container:
        raise ImportFailure('This audio format could not be saved in a playable container without re-encoding.')
    output = path.with_name('audio.' + container)
    try:
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path),
                        '-map', '0:a:0', '-c:a', 'copy', str(output)],
                       capture_output=True, check=True, timeout=120)
    except (subprocess.SubprocessError, OSError) as exc:
        raise ImportFailure('Could not copy the original audio stream. Check that FFmpeg is working.') from exc
    if not output.is_file() or not output.stat().st_size:
        raise ImportFailure('The audio stream was empty.')
    return output
