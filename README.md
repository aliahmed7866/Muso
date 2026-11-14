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

The player opens at [127.0.0.1:8765](http://127.0.0.1:8765). Tap **Install app**, or open Chrome's menu and choose **Install app** or **Add to Home screen**. Open Muso from its icon in a standalone window.

### Apply automatic recovery to an existing install

Run this once in Termux:

```bash
cd ~/Muso && git pull --ff-only && bash termux/service.sh install
```

The installer registers Muso with `termux-services` (runit), starts it now, and adds startup hooks for new Termux login shells and Termux:Boot. It migrates this checkout's old background launches and leaves other apps' processes, ports, services, boot hooks and data alone. It preserves your configured `MUSO_PORT` and `MUSO_DATA_DIR` in the service configuration; supply those variables during installation if you use custom values. Fresh installs set this up automatically.

- If Muso's server exits, its supervisor restarts it. If the supervisor exits, runit restarts that too.
- The watchdog checks local HTTP health every five seconds after a 30-second startup grace period. Three consecutive failures restart only Muso's child server. It also checks a server left alive by a killed supervisor.
- Opening a new Termux login shell starts the enabled service without typing a command. The player retries its connection and retains its queue.
- For automatic startup after a phone reboot, install **Termux:Boot from the same source/signing family as Termux**, then open Termux:Boot once. Muso's boot script is installed already.
- Set Android **Settings → Apps → Termux → Battery → Unrestricted** (wording varies by phone), and remove Termux from sleeping/deep-sleeping app lists. Muso acquires a Termux wake lock for screen-off operation; this uses additional battery. It does not release Termux's shared wake lock on stop because another app may need it. Release it manually with `termux-wake-unlock` when appropriate.

Android can still force-stop all of Termux. A browser cannot launch a dead Termux process itself; reopen Termux in that case. Automatic recovery operates while Termux's service manager can run. The script cannot change Android battery permissions or install/open the Termux:Boot Android app for you.

```bash
~/bin/muso status   # service state and HTTP readiness
~/bin/muso restart  # reload updated Python code
~/bin/muso stop     # stays stopped across new shells and phone reboots
~/bin/muso start    # re-enable and start
~/bin/muso enable   # install/repair automatic recovery
```

Diagnostics remain in `~/.local/share/muso/server.log` (or your custom data directory). The installer never restarts the shared Termux service daemon or uses broad process-killing commands.

## Discover music on demand

Tap **Discover → Discover Now** or run `~/bin/muso discover`. Each request searches for up to five tracks based on music in your library and skips duplicates. You can run another batch after it finishes, even if automatic discovery is paused or has reached its daily limit. Songs added on demand count toward that day's automatic allowance. View progress in Discover or run `~/bin/muso discover status`. New tracks appear under **Daily Finds**.

Use **Find music like this** from a song menu to start discovery around that track. General discovery favours liked and played music and looks for different performers before falling back to more tracks from a familiar artist. Use the skip options on Daily Finds to exclude songs or artists from future batches.

Song searches run as background jobs so the browser only makes short requests for their results. A dropped status request is retried automatically. **Retry search** reuses a matching search while it is still running. Search errors stay visible, and Discover Now shows the source error when a batch fails. If Muso cannot be reached, it retries automatically. If Android stopped Termux, reopen Termux. After updating Python code, use `~/bin/muso restart`; refreshing the page alone does not reload the backend.

Browse the library by artist, album, or genre. Muso uses available tags, and you can fill in missing album or genre details from the song menu. New online imports select yt-dlp's best available audio stream and preserve it without re-encoding. If the source offers only combined video and audio, FFmpeg copies the audio stream into a playable container. The song menu shows the reported format and bitrate when available.

- **YouTube and SoundCloud:** Paste a full song or video URL under **Add music**, or use Android **Share → Termux**. Muso saves downloadable audio through yt-dlp. Import recordings you have permission to save.
- **Spotify:** Share an individual track. Under **Imports**, choose a YouTube recording to save. If the suggestions are off, search by title and artist or paste the correct YouTube link. Spotify downloads and playlist URLs are unsupported.
- **Phone files:** Choose **Add music → Import audio files**. Files are copied into Muso, so the originals stay where they are.

## Playlists, queue, and recap

The Library has four listening mixes: **Your favourites**, **First listen**, **Rediscover**, and **Fresh arrivals**. They use saved music, likes, and listening history. Rediscover brings back songs last played more than two weeks ago; Fresh arrivals shows additions from the last two weeks. Tap a mix again or **All songs** to return to the full library. **Shuffle play** starts with a random song and includes every matching song once.

Use **Select songs** to choose several tracks, even across searches, then **Play next**, **Queue selected**, or **Add to playlist**. **Select matching** selects the current filtered results. Selection clears when you leave the collection. Playlist additions skip existing members; removing selected songs from a playlist keeps the audio in your library.

Open a playlist and tap **Edit playlist** to rename, reorder, remove songs, or duplicate it. Use the arrows on touchscreens or drag rows on desktop. **Queue playlist** adds the playlist in its saved order.

Tap the repeat button to choose **Off**, **Repeat queue**, or **Loop current song**. The song menu also has a **Loop this song** shortcut. Open **Queue** to reorder or remove upcoming songs, see their total duration, or **Save as playlist** (including the current song). **Undo queue change** restores the last removal, reorder, or clear while that queue and current song remain unchanged. Adding music skips songs already playing or queued; **Play next** moves an already queued song to the front.

**Sleep** offers 15, 30, 60, or 90 minutes, plus **After this song**. The timer shows its remaining minutes and remembers its deadline when the app is reopened. Stop after this song takes priority over repeat. Like playback itself, the timer needs Android to allow the browser to run; an overdue timer is checked when playback or the page resumes.

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

## Development checks

The regression checks use a temporary library and generated silent audio. They do not access your saved music or start discovery. In a development environment with Python requirements and Node.js installed:

```bash
npm install --no-save jsdom playwright
python -m unittest discover -s tests -p 'test_*.py'
MUSO_TEST_PYTHON=.venv/bin/python node tests/listening-dom.cjs
npx playwright install chromium
MUSO_TEST_PYTHON=.venv/bin/python node tests/listening.cjs
```

The DOM check exercises mixes, selection across filters, playlist membership, queue editing and saving, shuffle, sleep timer state and repeat precedence, and concurrent playlist edit conflicts against real Flask endpoints. It simulates audio and dialog APIs. The browser check additionally covers actual playback, page reload, and phone/desktop overflow. Set `MUSO_TEST_CHROMIUM` to use an existing Chromium executable, or `MUSO_TEST_SCREENSHOT` to save a phone screenshot.

The supervisor checks exercise real child crashes, replacement supervisors, hung-child recovery, and exact checkout/library targeting. To exercise installation, startup hooks, deliberate stop, and recovery under real runit in an isolated temporary prefix, set `MUSO_TEST_RUNIT_BIN` to a directory containing `sv`, `runsv`, and `runsvdir` when running the Python tests. These checks do not alter a real Termux prefix.
