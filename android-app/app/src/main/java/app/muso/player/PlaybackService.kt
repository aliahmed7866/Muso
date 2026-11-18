package app.muso.player

import android.app.PendingIntent
import android.content.Intent
import android.media.audiofx.Equalizer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

@UnstableApi
class PlaybackService : MediaSessionService() {
    companion object { const val COMMAND = "app.muso.player.CONTROL" }
    private lateinit var player: ExoPlayer
    private lateinit var session: MediaSession
    private val handler = Handler(Looper.getMainLooper())
    private var equalizer: Equalizer? = null
    private var sound = JSONObject()
    private var sleepUntil = 0L
    private var sleepAfterSong = false
    private var errorMessage = ""
    private var counted = false
    private var playedMs = 0L
    private var lastPosition = 0L
    private var ticks = 0
    private var restoring = false
    private val prefs by lazy { getSharedPreferences("native-playback", MODE_PRIVATE) }
    private val tick = object : Runnable {
        override fun run() {
            if (sleepUntil > 0 && System.currentTimeMillis() >= sleepUntil) {
                player.pause(); sleepUntil = 0; persist()
            }
            val position = player.currentPosition
            val difference = position - lastPosition
            if (player.isPlaying && difference in 1..2000) playedMs += difference
            lastPosition = position
            val threshold = if (player.duration > 0) minOf(5000L, player.duration / 2) else 5000L
            if (!counted && player.isPlaying && playedMs >= threshold) {
                counted = true
                player.currentMediaItem?.mediaId?.let { id ->
                    EmbeddedEngine.io.execute { runCatching { EmbeddedEngine.start(this@PlaybackService).get().callAttr("played", id) } }
                }
            }
            if (++ticks % 10 == 0) persist()
            handler.postDelayed(this, 500)
        }
    }

    override fun onCreate() {
        super.onCreate()
        player = ExoPlayer.Builder(this).build().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            setHandleAudioBecomingNoisy(true)
            setWakeMode(C.WAKE_MODE_LOCAL)
        }
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                if (!restoring) { counted = false; playedMs = 0; lastPosition = 0; errorMessage = "" }
                persist()
            }
            override fun onAudioSessionIdChanged(audioSessionId: Int) {
                equalizer?.release()
                equalizer = runCatching { Equalizer(0, audioSessionId) }.getOrNull()
                applySound()
            }
            override fun onPlayerError(error: PlaybackException) {
                errorMessage = "This audio could not be played. Try another song or import the file again."
                persist()
            }
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM && sleepAfterSong) {
                    sleepAfterSong = false; player.pauseAtEndOfMediaItems = false
                }
                persist()
            }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                lastPosition = player.currentPosition
            }
        })
        val launch = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        session = MediaSession.Builder(this, player).setSessionActivity(launch).setCallback(object : MediaSession.Callback {
            override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                if (controller.packageName != packageName && !controller.isTrusted) return MediaSession.ConnectionResult.reject()
                val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                if (controller.packageName == packageName) commands.add(SessionCommand(COMMAND, Bundle.EMPTY))
                return MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailableSessionCommands(commands.build()).build()
            }
            override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, command: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
                if (controller.packageName != packageName || command.customAction != COMMAND) return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_PERMISSION_DENIED))
                return try {
                    val request = JSONObject(args.getString("json") ?: "{}")
                    handle(request)
                    Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS, Bundle().apply { putString("json", snapshot().toString()) }))
                } catch (_: Exception) { Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_BAD_VALUE)) }
            }
        }).build()
        restore()
        handler.post(tick)
    }

    private fun parseItems(values: JSONArray): List<MediaItem> {
        require(values.length() <= 10000)
        val folder = File(filesDir, "library/media").canonicalFile
        return (0 until values.length()).mapNotNull { index ->
            val item = values.getJSONObject(index)
            val path = File(item.getString("path")).canonicalFile
            if (path.parentFile != folder || !path.isFile) null else MediaItem.Builder()
                .setMediaId(item.getString("id")).setUri(Uri.fromFile(path))
                .setMediaMetadata(MediaMetadata.Builder().setTitle(item.optString("title", "Untitled"))
                    .setArtist(item.optString("artist", "Unknown artist")).setAlbumTitle(item.optString("album"))
                    .setIsPlayable(true).build()).build()
        }
    }

    private fun handle(request: JSONObject) {
        when (request.getString("op")) {
            "state" -> return
            "load" -> {
                val items = parseItems(request.getJSONArray("items"))
                val index = items.indexOfFirst { it.mediaId == request.optString("current") }
                require(index >= 0) { "Song unavailable" }
                counted = false; playedMs = 0; lastPosition = 0; errorMessage = ""
                player.setMediaItems(items, index, 0)
                setRepeat(request.optInt("repeat"))
                player.prepare(); player.play()
            }
            "queue" -> {
                // A delayed UI update must never undo a native background transition.
                if (player.currentMediaItem?.mediaId != request.optString("current")) return
                val items = parseItems(request.getJSONArray("items"))
                val index = items.indexOfFirst { it.mediaId == player.currentMediaItem?.mediaId }
                if (index >= 0) {
                    val ids = items.map { it.mediaId }
                    val existing = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
                    if (ids != existing) {
                        // Replace only entries around the current item, so edits never restart audio.
                        val oldIndex = player.currentMediaItemIndex
                        player.removeMediaItems(oldIndex + 1, player.mediaItemCount)
                        player.removeMediaItems(0, oldIndex)
                        player.addMediaItems(0, items.take(index))
                        player.addMediaItems(items.drop(index + 1))
                    }
                }
                setRepeat(request.optInt("repeat"))
            }
            "play" -> {
                if (player.playbackState == Player.STATE_IDLE) player.prepare()
                if (player.playbackState == Player.STATE_ENDED) player.seekToDefaultPosition()
                errorMessage = ""; player.play()
            }
            "pause" -> player.pause()
            "seek" -> player.seekTo((request.optDouble("seconds", 0.0).coerceAtLeast(0.0) * 1000).toLong())
            "next" -> if (player.hasNextMediaItem()) { player.seekToNextMediaItem(); player.play() }
            "previous" -> { player.seekToPrevious(); player.play() }
            "clear" -> { player.stop(); player.clearMediaItems() }
            "sound" -> { sound = request.getJSONObject("settings"); applySound() }
            "sleep" -> {
                sleepUntil = request.optLong("until").coerceIn(0L, System.currentTimeMillis() + 120 * 60000L)
                sleepAfterSong = request.optBoolean("afterSong")
                player.pauseAtEndOfMediaItems = sleepAfterSong
            }
            else -> error("Unsupported playback operation")
        }
        persist()
    }

    private fun setRepeat(mode: Int) {
        player.repeatMode = when (mode) { 1 -> Player.REPEAT_MODE_ALL; 2 -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF }
    }
    private fun applySound() {
        val enabled = sound.optBoolean("enabled")
        val boost = listOf("bass", "mid", "treble").sumOf { sound.optDouble(it, 0.0).coerceIn(0.0, 6.0) }
        val headroom = if (enabled) Math.pow(10.0, -boost / 20.0) else 1.0
        player.volume = (sound.optDouble("volume", 100.0).coerceIn(0.0, 100.0) / 100.0 * headroom).toFloat()
        player.playbackParameters = PlaybackParameters(sound.optDouble("speed", 1.0).coerceIn(.75, 1.5).toFloat(), 1f)
        runCatching {
            equalizer?.let { eq ->
                eq.enabled = enabled
                val range = eq.bandLevelRange
                for (band in 0 until eq.numberOfBands.toInt()) {
                    val hz = eq.getCenterFreq(band.toShort()) / 1000
                    val key = if (hz < 300) "bass" else if (hz > 3000) "treble" else "mid"
                    val level = (sound.optDouble(key, 0.0).coerceIn(-6.0, 6.0) * 100).toInt().coerceIn(range[0].toInt(), range[1].toInt())
                    eq.setBandLevel(band.toShort(), level.toShort())
                }
            }
        }
    }
    private fun snapshot(): JSONObject {
        val all = JSONArray()
        for (i in 0 until player.mediaItemCount) all.put(player.getMediaItemAt(i).mediaId)
        return JSONObject().put("ids", all).put("index", player.currentMediaItemIndex.coerceAtLeast(0))
            .put("current", player.currentMediaItem?.mediaId ?: "")
            .put("position", player.currentPosition.coerceAtLeast(0) / 1000.0)
            .put("duration", if (player.duration > 0) player.duration / 1000.0 else 0)
            .put("playing", player.playWhenReady && player.playbackState != Player.STATE_ENDED && player.playbackState != Player.STATE_IDLE)
            .put("repeat", when (player.repeatMode) { Player.REPEAT_MODE_ALL -> 1; Player.REPEAT_MODE_ONE -> 2; else -> 0 }).put("sleepUntil", sleepUntil).put("sleepAfterSong", sleepAfterSong)
            .put("sound", sound).put("eqAvailable", equalizer != null).put("error", errorMessage)
    }
    private fun persist() {
        if (restoring || !::player.isInitialized) return
        val saved = snapshot()
        val items = JSONArray()
        for (i in 0 until player.mediaItemCount) {
            val item = player.getMediaItemAt(i)
            items.put(JSONObject().put("id", item.mediaId).put("title", item.mediaMetadata.title)
                .put("artist", item.mediaMetadata.artist).put("album", item.mediaMetadata.albumTitle)
                .put("path", item.localConfiguration?.uri?.path))
        }
        saved.put("items", items).put("counted", counted)
        prefs.edit().putString("state", saved.toString()).apply()
    }
    private fun restore() {
        restoring = true
        try {
            val saved = JSONObject(prefs.getString("state", "{}") ?: "{}")
            sound = saved.optJSONObject("sound") ?: JSONObject()
            val items = parseItems(saved.optJSONArray("items") ?: JSONArray())
            val index = items.indexOfFirst { it.mediaId == saved.optString("current") }
            if (index >= 0) {
                player.setMediaItems(items, index, (saved.optDouble("position", 0.0) * 1000).toLong().coerceAtLeast(0))
                player.prepare() // Never autoplay after process death or a force stop.
            }
            counted = saved.optBoolean("counted")
            setRepeat(saved.optInt("repeat"))
            sleepUntil = saved.optLong("sleepUntil").takeIf { it > System.currentTimeMillis() } ?: 0
            sleepAfterSong = saved.optBoolean("sleepAfterSong")
            player.pauseAtEndOfMediaItems = sleepAfterSong
            applySound()
        } catch (_: Exception) { /* The library remains intact if playback state is obsolete. */ }
        finally { restoring = false }
    }
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session
    override fun onDestroy() {
        persist()
        handler.removeCallbacksAndMessages(null)
        equalizer?.release()
        session.release()
        player.release()
        super.onDestroy()
    }
}
