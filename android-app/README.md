# Muso Android 0.3 — integrated library edition

This APK bundles the existing Muso interface and Flask library logic in the app with Chaquopy. Requests run in process: **no Termux, localhost server, port, shell or separate installation is required**. Native Media3 ExoPlayer and a MediaSessionService own audio playback, the queue, media notification, Bluetooth transport, audio focus, headphones disconnect handling, sleep timers and listening counts. Closing/recreating the screen does not own or stop music.

## Included

- The original Library, Discover, Playlists, Liked songs, Recap, Imports and Now Playing screens.
- Android's document picker imports multiple audio files into the app's private storage without re-encoding. No broad storage permission.
- Duplicate-aware imports, playlist editing, search, queue editing, shuffle, repeat, seek, and playback state recovery. A process restart restores paused; it never silently autoplays.
- Native volume and pitch-preserving speed. Device-supported Android equalizer with three UI bands and gain headroom.
- Bundled yt-dlp and EJS with an Android isolated JavaScript engine, rather than subprocesses requiring Node/FFmpeg/Termux. Audio-only streams are retained without transcoding. Spotify links identify songs for a recording match, not Spotify audio downloads.
- Receiving shared song links opens the import form for review.
- Add music → Transfer & backup brings over songs, playlists, likes and listening history. Restore adds content; it does not clear an existing library. Reimporting the same backup does not duplicate songs, playlists or history.

## Install / compatibility

Android 8 or newer on **64-bit ARM phones** (plus x86_64 emulators), with a current Android System WebView. Install the signed release APK supplied with this work. If Android reports an incompatible existing package, the old debug preview has a different signing certificate; Android will not install one certificate over another. Export any app-owned data before removing an existing version. The older 0.1 preview only read phone music and never owned those audio files.

## Bring your Termux library over

1. In the APK open **Add music → Transfer & backup → Save Termux export tool**. Save to Downloads as `Muso-transfer.py`.
2. In Termux, enable shared storage with `termux-setup-storage` if needed, and allow access. Run `python ~/storage/downloads/Muso-transfer.py` (the app has a Copy command button).
3. Wait for Done. Return to the APK and choose the new `Muso-backup-YYYYMMDD-HHMMSS.zip` from Downloads. Review song/playlist/history counts, matching files and storage, then tap **Import into Muso**.

The tool is self-contained Python using only the standard library; no internet access or update to the Termux checkout is needed. It detects `MUSO_DATA_DIR`, `MUSO_SERVICE_DATA_DIR`, the installed service's literal data directory, or `~/.local/share/muso`. For a custom location run `python ~/storage/downloads/Muso-transfer.py --data-dir /your/data/folder`. It never runs the service config as shell commands. Existing checkout users can also run `python termux/export-android.py`.

Transfers preserve songs without re-encoding, playlists, likes and listening history. Existing content is merged, and repeating a restore skips duplicates. Originals stay in Termux. Keep enough free space for the selected ZIP and imported music. Portable backups allow up to 10 GB total and 512 MB per song. Jobs and browser-only preferences are not transferred.

**Save Android backup** exports the app's library to a ZIP through the system document picker. Keep the app open until transfer/export finishes. Transfer status and the selected ZIP survive screen recreation; after process interruption, reopen this screen and retry safely. Incomplete external exports are removed when the app can detect a write failure. If Android kills the process during export, delete the incomplete ZIP and export again.

## Build and signing

GitHub Actions → **Muso Android APK** on `feature/android-offline-apk` builds debug and unsigned release APKs, runs Android lint, then runs an API 35 emulator instrumentation test. The `muso-android-apks` artifact also contains `apksigner.jar`; the reports artifact contains device test reports and screenshots.

Local build: JDK 17, Python 3.13, Gradle 8.13, Android SDK 35:

```bash
cd android-app
gradle :app:assembleRelease :app:lintDebug
```

The release APK must be signed with the same protected keystore for every update. Never commit private keys or passwords. The separate signing backup supplied with the installer must be kept privately for future upgrades. CI debug keys are not release identities.

## Boundaries

- Native crossfade is **not included**; the Sound screen explicitly says so. The browser/Termux version retains its tested two-deck crossfade.
- Source sites may reject or restrict individual imports. No guarantees for a particular provider, track, account, or region. Discovery is off by default on a fresh install and can be enabled in the app. No DRM bypass or service credentials are included.
- Imports run in the app process. Android may stop them if the app is closed while no media is playing; pending work resumes on reopening. Playback uses the appropriate foreground media service, but force stop and device-specific battery policies still apply.
- This is an installable personal Android build, **not a Play Store submission**. Play publication, policy declarations, production signing custody and physical-device testing remain separate work.

## Privacy / security

Music, playlists and listening history stay in private app storage. There is no telemetry or advertising SDK. Online search/import contacts the source services the user chooses. Android cloud backup is disabled for this app. The WebView loads only a bundled origin, denies file/content access and external subresources, uses an origin-restricted main-frame message bridge, and hands external web links to the browser. Backend methods are bounded; native file paths are resolved from the library, not accepted from page input. Downloaded source scripts run in an isolated JS process without app APIs.

Validation includes existing backend/browser tests, Android bridge DOM tests, migration round trips and hostile archive paths, and device tests for the bundled UI, import/database integration, real native playback, background next-track progression, Activity recreation, seeking, repeat and timed pause. See the exact workflow result for the tested commit; an APK build alone is not evidence of device test success.
