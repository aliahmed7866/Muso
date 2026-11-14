# Muso

A free, ad-free music library that runs on your Android phone with Termux. Saved audio plays without internet while Muso is running. Search your library, like songs, make playlists, queue tracks, and use the browser's Android media controls.

## Install on Termux

```bash
pkg install -y git
git clone https://github.com/aliahmed7866/Muso.git ~/Muso
cd ~/Muso
bash termux/install.sh
~/bin/muso open
```

The player opens at [127.0.0.1:8765](http://127.0.0.1:8765). Tap **Install app**, or open Chrome's menu and choose **Install app** or **Add to Home screen**. Open Muso from its icon in a standalone window. Keep Termux running during playback and imports. If Android stops Termux, run `~/bin/muso start` before opening the icon again.

## Discover music on demand

Tap **Discover → Discover Now** or run `~/bin/muso discover`. Each request searches for up to five tracks based on music in your library and skips duplicates. You can run another batch after it finishes, even if automatic discovery is paused or has reached its daily limit. Songs added on demand count toward that day's automatic allowance. View progress in Discover or run `~/bin/muso discover status`. New tracks appear under **Daily Finds**.

Use **Find music like this** from a song menu to start discovery around that track. General discovery favours liked and played music and looks for different performers before falling back to more tracks from a familiar artist. Use the skip options on Daily Finds to exclude songs or artists from future batches.

Browse the library by artist, album, or genre. Muso uses available tags, and you can fill in missing album or genre details from the song menu. New online imports select yt-dlp's best available audio stream and preserve it without re-encoding. If the source offers only combined video and audio, FFmpeg copies the audio stream into a playable container. The song menu shows the reported format and bitrate when available.

- **YouTube and SoundCloud:** Paste a full song or video URL under **Add music**, or use Android **Share → Termux**. Muso saves downloadable audio through yt-dlp. Import recordings you have permission to save.
- **Spotify:** Share an individual track. Under **Imports**, choose a YouTube recording to save. If the suggestions are off, search by title and artist or paste the correct YouTube link. Spotify downloads and playlist URLs are unsupported.
- **Phone files:** Choose **Add music → Import audio files**. Files are copied into Muso, so the originals stay where they are.

## Playlists, queue, and recap

Open a playlist and tap **Edit playlist** to rename, reorder, remove songs, or duplicate it. Use the arrows on touchscreens or drag rows on desktop. **Queue playlist** adds the playlist in its saved order.

Tap the repeat button to choose **Off**, **Repeat queue**, or **Loop current song**. The song menu also has a **Loop this song** shortcut. Open **Queue** to reorder or remove upcoming songs.

**Recap** shows monthly plays, unique songs and artists, and your top songs and artists. Use the month buttons to look back, or save that month's top songs as a playlist. Monthly history begins with this update. Earlier play totals remain available for library sorting.

If Termux already has a `~/bin/termux-url-opener`, the installer preserves it. Add an explicit call to `"$HOME/bin/muso" share "$1"` in the appropriate branch of your existing handler, or paste links into Muso.

## Run alongside other apps

Muso uses port 8765 and stores music and SQLite data in `~/.local/share/muso`. Set `MUSO_PORT` before launch if that port is in use. Use the same setting when passing a shared link. `~/bin/muso serve` runs in the foreground for a service supervisor, `~/bin/muso start` starts in the background, and `~/bin/muso status` checks readiness. The health endpoint is `/api/health`. To back up the library, stop Muso and copy its data directory.

If online imports fail after a provider change, update the downloader and retry under **Imports**:

```bash
~/Muso/.venv/bin/python -m pip install -U 'yt-dlp[default]'
```

### Media Hub

The AYCF Admin Hub calls the [Django YouTube video and MP3 downloader](https://github.com/aliahmed7866/Django-youtube-video-and-mp3-downloader) **Media Hub**. Its default port is 8083, separate from Muso's 8765. Export a copy of an audio download from Media Hub and choose that file in Muso's **Add music** dialog.

To route Spotify shares to Muso while keeping your other shares in Media Hub, add the following before the final `exec` in your existing `~/bin/termux-url-opener`:

```bash
case "${1:-}" in
  *open.spotify.com/*) exec "$HOME/bin/muso" share "$@" ;;
esac
```

Use **Add music** in Muso for YouTube or SoundCloud links when Media Hub owns the shared handler.
