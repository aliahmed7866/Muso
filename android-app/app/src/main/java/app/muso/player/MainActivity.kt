package app.muso.player

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import android.webkit.*
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID

@androidx.media3.common.util.UnstableApi
class MainActivity : ComponentActivity() {
    companion object { const val ORIGIN = "https://muso.android.localhost" }
    private lateinit var web: WebView
    private lateinit var root: LinearLayout
    private var controller: MediaController? = null
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var importReply: String? = null
    private var importingBackup = false
    private var destroyed = false
    private var pageReady = false
    private var sharedText: String? = null
    private val pickAudio = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val id = importReply ?: return@registerForActivityResult
        importReply = null
        val backup = importingBackup
        EmbeddedEngine.io.execute {
            try {
                val backend = EmbeddedEngine.start(this).get()
                var saved = 0; var duplicates = 0
                val errors = JSONArray()
                for (uri in uris) {
                    var file: File? = null
                    try {
                        val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                            if (it.moveToFirst()) it.getString(0) else null
                        } ?: "audio"
                        val ext = name.substringAfterLast('.', "").lowercase()
                        require(if (backup) ext == "zip" else ext in setOf("mp3", "m4a", "flac", "wav", "ogg", "opus", "aac")) { "Unsupported audio: $name" }
                        val folder = File(filesDir, "library/imports").apply { mkdirs() }
                        file = File(folder, "${UUID.randomUUID()}.$ext")
                        contentResolver.openInputStream(uri)?.use { input ->
                            file.outputStream().use { output ->
                                val buffer = ByteArray(65536); var total = 0L
                                while (true) {
                                    val count = input.read(buffer)
                                    if (count < 0) break
                                    total += count
                                    require(total <= (if (backup) 10L * 1024 * 1024 * 1024 else 512L * 1024 * 1024)) { "Selected file is too large" }
                                    output.write(buffer, 0, count)
                                }
                            }
                        } ?: error("Could not open $name")
                        if (backup) {
                            val result = JSONObject(backend.callAttr("import_backup", file.absolutePath).toString())
                            saved += result.getInt("saved"); duplicates += result.getInt("duplicates")
                            val issues = result.getJSONArray("errors")
                            for (i in 0 until issues.length()) errors.put(issues.getString(i))
                            continue
                        }
                        val result = JSONObject(backend.callAttr("import_file", file.absolutePath, name).toString())
                        if (result.optBoolean("duplicate")) duplicates++ else saved++
                    } catch (error: Exception) { errors.put(error.message ?: "Could not import audio") }
                    finally { file?.delete() }
                }
                reply(id, JSONObject().put("saved", saved).put("duplicates", duplicates).put("errors", errors))
            } catch (error: Exception) { fail(id, error) }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(16, 18, 24)
        window.navigationBarColor = Color.rgb(16, 18, 24)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(16, 18, 24)) }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val loading = TextView(this).apply {
            text = "Muso\nGetting your music ready…"; textSize = 24f
            setTextColor(Color.WHITE); setPadding(32, 64, 32, 32)
        }
        root.addView(loading)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            loading.text = "Update Android System WebView in Google Play, then reopen Muso."
            return
        }
        web = WebView(this).apply {
            setBackgroundColor(Color.rgb(16, 18, 24))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.setSupportMultipleWindows(false)
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        WebViewCompat.addWebMessageListener(web, "MusoBridge", setOf(ORIGIN)) { _, message, origin, main, _ ->
            if (main && origin.toString() == ORIGIN) handleMessage(message.data ?: "")
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                if (request.url.scheme != "https" || request.url.host != "muso.android.localhost" || request.url.port != -1 || request.method != "GET") return blocked()
                return try {
                    val asset = EmbeddedEngine.start(this@MainActivity).get().callAttr("asset", request.url.path ?: "/").asList()
                    WebResourceResponse(asset[0].toString(), "UTF-8", 200, "OK", mapOf(
                        "Content-Security-Policy" to "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'none'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'",
                        "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"
                    ), ByteArrayInputStream(asset[1].toJava(ByteArray::class.java)))
                } catch (_: Exception) { blocked() }
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.toString().startsWith("$ORIGIN/") && request.url.host == "muso.android.localhost") return false
                if (request.isForMainFrame && request.url.scheme in setOf("https", "http")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) { }
                }
                return true
            }
            override fun onPageFinished(view: WebView, url: String) {
                pageReady = url == "$ORIGIN/"
                deliverShare()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(message)
                    .setPositiveButton("Confirm") { _, _ -> result.confirm() }
                    .setNegativeButton("Cancel") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("Boolean(document.querySelector('dialog[open]'))") { open ->
                    if (open == "true") web.evaluateJavascript("document.querySelector('dialog[open]').close()", null)
                    else moveTaskToBack(true)
                }
            }
        })
        readShare(intent)
        EmbeddedEngine.io.execute {
            try {
                EmbeddedEngine.start(this).get()
                runOnUiThread {
                    if (destroyed) return@runOnUiThread
                    val future = MediaController.Builder(this, SessionToken(this, ComponentName(this, PlaybackService::class.java))).buildAsync()
                    controllerFuture = future
                    future.addListener({
                        try {
                            controller = future.get()
                            root.removeAllViews()
                            root.addView(web, LinearLayout.LayoutParams(-1, -1))
                            web.loadUrl("$ORIGIN/")
                        } catch (error: Exception) { loading.text = "Could not start Muso. Close and reopen the app.\n${error.message}" }
                    }, ContextCompat.getMainExecutor(this))
                }
            } catch (error: Exception) { runOnUiThread { loading.text = "Could not start Muso.\n${error.message}" } }
        }
    }

    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun handleMessage(raw: String) {
        if (raw.length > 1_000_000) return
        val request = try { JSONObject(raw) } catch (_: Exception) { return }
        val id = request.optString("id")
        if (!id.matches(Regex("[0-9]{1,12}"))) return
        val action = request.optString("action")
        val args = request.optJSONObject("args") ?: JSONObject()
        if (action == "import" || action == "backup") {
            if (importReply != null) { fail(id, IllegalStateException("An import is already open")); return }
            importReply = id
            importingBackup = action == "backup"
            pickAudio.launch(if (importingBackup) arrayOf("application/zip", "application/x-zip-compressed") else arrayOf("audio/*", "application/ogg"))
            return
        }
        val executor = if (action == "playback") EmbeddedEngine.commands else EmbeddedEngine.io
        executor.execute {
            try {
                val backend = EmbeddedEngine.start(this).get()
                when (action) {
                    "api" -> reply(id, JSONObject(backend.callAttr("api", "/api/" + args.getString("path"), args.getString("method"), args.opt("body")?.takeUnless { it == JSONObject.NULL }?.toString() ?: "").toString()))
                    "playback" -> {
                        if (args.optString("op") in setOf("load", "queue")) {
                            args.put("items", JSONArray(backend.callAttr("items", args.getJSONArray("ids").toString()).toString()))
                        }
                        runOnUiThread {
                            val player = controller
                            if (player == null) { fail(id, IllegalStateException("Player is starting")); return@runOnUiThread }
                            val result = player.sendCustomCommand(SessionCommand(PlaybackService.COMMAND, Bundle.EMPTY), Bundle().apply { putString("json", args.toString()) })
                            result.addListener({
                                try {
                                    val response = result.get()
                                    if (response.resultCode != 0) error("Playback command failed")
                                    reply(id, JSONObject(response.extras.getString("json") ?: "{}"))
                                } catch (error: Exception) { fail(id, error) }
                            }, ContextCompat.getMainExecutor(this))
                        }
                    }
                    else -> error("Unknown app action")
                }
            } catch (error: Exception) { fail(id, error) }
        }
    }
    private fun reply(id: String, result: JSONObject) = runOnUiThread {
        if (!destroyed) web.evaluateJavascript("window.MusoAndroid?.resolve($id,${result},null)", null)
    }
    private fun fail(id: String, error: Exception) = runOnUiThread {
        if (!destroyed) web.evaluateJavascript("window.MusoAndroid?.resolve($id,null,${JSONObject.quote(error.message ?: "Muso could not complete this action")})", null)
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); readShare(intent); deliverShare() }
    private fun readShare(intent: Intent) {
        if (intent.action == Intent.ACTION_SEND && intent.type == "text/plain") sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)?.take(4000)
    }
    private fun deliverShare() {
        val text = sharedText ?: return
        if (!pageReady) return
        web.evaluateJavascript("window.MusoAndroid.shared = ${JSONObject.quote(text)}; window.dispatchEvent(new Event('muso-share'))", null)
        sharedText = null
    }
    override fun onDestroy() {
        destroyed = true
        controllerFuture?.let { MediaController.releaseFuture(it) }
        if (::web.isInitialized) { root.removeView(web); web.destroy() }
        super.onDestroy()
    }
}
