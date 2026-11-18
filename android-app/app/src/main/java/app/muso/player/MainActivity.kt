package app.muso.player

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import android.content.ComponentName

data class Song(val id: Long, val title: String, val artist: String, val uri: android.net.Uri)

class MainActivity : ComponentActivity() {
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val songs = mutableListOf<Song>()
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var nowPlaying: TextView
    private lateinit var playButton: Button
    private var searched = ""

    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) refreshSongs() else status.text = "Audio access denied. Grant music permission in Android Settings."
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(15, 17, 22)
        window.navigationBarColor = Color.rgb(15, 17, 22)
        buildUi()
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            try {
                controller = future.get()
                controller?.addListener(object : Player.Listener {
                    override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) = updateNowPlaying()
                    override fun onIsPlayingChanged(isPlaying: Boolean) = updateNowPlaying()
                })
                updateNowPlaying()
            } catch (_: Exception) { status.text = "Unable to connect to audio playback." }
        }, ContextCompat.getMainExecutor(this))
        requestAudioPermission()
    }

    private fun buildUi() {
        val bg = Color.rgb(19, 21, 26)
        val fg = Color.rgb(247, 246, 249)
        val panel = Color.rgb(36, 39, 46)
        val accent = Color.rgb(213, 249, 125)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(18, 30, 18, 16); setBackgroundColor(bg) }
        val title = TextView(this).apply { text = "≋  Muso"; textSize = 30f; setTextColor(accent); setPadding(0, 0, 0, 16) }
        root.addView(title)
        val search = EditText(this).apply { hint = "Search your songs"; setSingleLine(); setTextColor(fg); setHintTextColor(Color.LTGRAY); setBackgroundColor(panel); setPadding(16, 10, 16, 10) }
        root.addView(search)
        status = TextView(this).apply { text = "Loading your phone's music…"; setTextColor(Color.LTGRAY); setPadding(0, 18, 0, 10) }
        root.addView(status)
        val scroll = ScrollView(this)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(list)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        nowPlaying = TextView(this).apply { text = "Choose a song"; setTextColor(fg); textSize = 16f; setPadding(6, 20, 6, 10) }
        root.addView(nowPlaying)
        val controls = LinearLayout(this).apply { gravity = Gravity.CENTER }
        fun control(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { action() } }.also {
            controls.addView(it, LinearLayout.LayoutParams(0, -2, 1f))
        }
        control("Previous") { controller?.seekToPreviousMediaItem() }
        playButton = control("Play") { controller?.let { if (it.isPlaying) it.pause() else it.play() } }
        control("Next") { controller?.seekToNextMediaItem() }
        root.addView(controls)
        setContentView(root)
        search.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { searched = s.toString(); showSongs() }
            override fun afterTextChanged(s: android.text.Editable?) {}
        })
    }

    private fun requestAudioPermission() {
        val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
        if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) refreshSongs()
        else permissionRequest.launch(permission)
    }

    private fun refreshSongs() {
        songs.clear()
        val columns = arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST)
        val order = "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC"
        try {
            contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, columns,
                "${MediaStore.Audio.Media.IS_MUSIC} != 0", null, order)?.use { cursor ->
                val idCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val titleCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                val artistCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(idCol)
                    songs.add(Song(id, cursor.getString(titleCol) ?: "Untitled",
                        cursor.getString(artistCol) ?: "Unknown artist",
                        ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)))
                }
            }
            status.text = "${songs.size} songs on this device · offline playback"
            showSongs()
        } catch (error: Exception) { status.text = "Could not read audio files: ${error.message}" }
    }

    private fun showSongs() {
        list.removeAllViews()
        val matching = songs.filter { searched.isBlank() || it.title.contains(searched, true) || it.artist.contains(searched, true) }
        for (song in matching) {
            val row = TextView(this).apply {
                text = "${song.title}\n${song.artist}"
                textSize = 16f
                setTextColor(Color.WHITE)
                setPadding(16, 16, 12, 16)
                setOnClickListener { playSong(song) }
            }
            list.addView(row, LinearLayout.LayoutParams(-1, -2))
            val line = View(this).apply { setBackgroundColor(Color.rgb(50, 53, 60)) }
            list.addView(line, LinearLayout.LayoutParams(-1, 1))
        }
        if (matching.isEmpty()) list.addView(TextView(this).apply {
            text = if (songs.isEmpty()) "No music found. Add audio files to your phone and reopen Muso." else "No matches."
            setTextColor(Color.LTGRAY); setPadding(14, 20, 14, 20)
        })
    }

    private fun playSong(song: Song) {
        val player = controller ?: run { status.text = "Audio player is initializing. Try again."; return }
        val items = songs.map {
            MediaItem.Builder().setUri(it.uri).setMediaId(it.id.toString())
                .setMediaMetadata(MediaMetadata.Builder().setTitle(it.title).setArtist(it.artist).build()).build()
        }
        val index = songs.indexOf(song)
        player.setMediaItems(items, index, 0)
        player.prepare()
        player.play()
        updateNowPlaying()
    }

    private fun updateNowPlaying() {
        val player = controller
        nowPlaying.text = if (player?.currentMediaItem == null) "Choose a song"
            else "${player.mediaMetadata.title ?: "Untitled"} · ${player.mediaMetadata.artist ?: "Unknown artist"}"
        playButton.text = if (player?.isPlaying == true) "Pause" else "Play"
    }

    override fun onDestroy() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onDestroy()
    }
}
