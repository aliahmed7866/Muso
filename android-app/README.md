# Muso Android — standalone offline preview

This is a **first native Android prototype**, deliberately separate from the Termux/Flask Muso implementation. It reads music indexed by Android MediaStore and plays it using Media3 ExoPlayer + MediaSessionService (lock-screen/notification/Bluetooth media transport). It does **not** run Flask, require Termux, or use port 8765.

## Building the APK
Open GitHub **Actions → Android APK (offline preview) → Run workflow** on this branch, or push a change to this branch. Download the **muso-android-debug-apk** artifact and install the APK in its ZIP. Alternatively use Android Studio or run `gradle :app:assembleDebug` with JDK 17 and Android SDK 35.

This APK is debug signed for **personal testing only**. Signing and Play Store release require a separately protected release keystore and additional policy/testing work.

## Current scope and limitations
- Implemented: local on-device audio enumeration, search by title/artist, play/pause, next/previous, Android media session and foreground service, basic dark UI.
- Not yet ported: original Muso playlists, liked songs, existing SQLite library, discovery, download/import jobs, monthly recap, EQ/crossfade, queue editing, artwork and polished screens.
- Existing Muso-owned files under Termux private storage will **not** appear in MediaStore automatically. Export/copy music to an Android shared audio folder to test; do not delete the originals.
- No networking or web-download permissions are requested. Copyright and source-terms checks are needed before any future online download integration.

The existing Flask/Termux application remains unchanged. Never treat this prototype as feature complete or Play Store ready.
