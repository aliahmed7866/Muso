"""Use yt-dlp as a library; Android cannot launch a Python/Node/FFmpeg shell."""
import re
import time
from pathlib import Path
from importer import ImportFailure, normalize_link


def options(timeout=120):
    deadline = time.monotonic() + timeout
    def progress(_):
        if time.monotonic() > deadline:
            raise ImportFailure('The source timed out. Retry with a stable connection.')
    return dict(quiet=True, no_warnings=True, socket_timeout=20, retries=2,
                noplaylist=True, cachedir=False, progress_hooks=[progress])


def search(query):
    from yt_dlp import YoutubeDL
    query = str(query).strip()[:160]
    if not query:
        raise ImportFailure('Enter a song and artist to search.')
    try:
        with YoutubeDL(dict(options(), extract_flat=True, playlistend=6)) as ydl:
            data = ydl.extract_info('ytsearch6:' + query, download=False)
        return [dict(title=e.get('title') or 'Untitled',
                     artist=e.get('uploader') or e.get('channel') or 'YouTube',
                     duration=e.get('duration') or 0,
                     url='https://www.youtube.com/watch?v=' + e['id'])
                for e in (data or {}).get('entries', []) if e and
                re.fullmatch(r'[\w-]{11}', e.get('id', ''), re.ASCII)]
    except Exception as exc:
        raise ImportFailure('Online search is unavailable from this source. Check your connection and retry.') from exc


def download(url, folder):
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import match_filter_func
    provider, canonical = normalize_link(url)
    if provider == 'spotify':
        raise ImportFailure('Choose a YouTube recording first.')
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    opts = dict(options(900), format='bestaudio[vcodec=none]',
                max_filesize=500 * 1024 * 1024,
                match_filter=match_filter_func('!is_live & duration <= 3600'),
                outtmpl=str(folder / 'source.%(ext)s'), fixup='never')
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(canonical, download=True)
        if not info or info.get('vcodec') != 'none':
            raise ValueError('No audio-only stream')
        ext = str(info.get('ext', ''))
        if ext not in {'mp3','m4a','opus','ogg','flac','wav','webm','aac'}:
            raise ValueError('Unsupported audio container')
        path = folder / ('source.' + ext)
        if not path.is_file() or not path.stat().st_size:
            raise ValueError('No audio returned')
        return path, dict(title=info.get('track') or info.get('title') or 'Untitled',
                          artist=info.get('artist') or info.get('uploader') or 'Unknown artist',
                          album=info.get('album') or '', genre=info.get('genre') or '',
                          duration=info.get('duration') or 0, source=provider,
                          source_url=canonical, codec=info.get('acodec') or ext,
                          bitrate=round(info.get('abr') or 0))
    except Exception as exc:
        raise ImportFailure('This source did not provide downloadable audio on Android. '
                            'The source may be restricted or temporarily unavailable. '
                            'You can still import an audio file from your phone.') from exc
