package app.muso.player

import android.content.Context
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.Future

object EmbeddedEngine {
    val io = Executors.newFixedThreadPool(3)
    val commands = Executors.newSingleThreadExecutor()
    private var startup: Future<PyObject>? = null

    @Synchronized fun start(context: Context): Future<PyObject> {
        startup?.let { return it }
        val app = context.applicationContext
        val future = io.submit<PyObject> {
            ChallengeRuntime.initialize(app)
            if (!Python.isStarted()) Python.start(AndroidPlatform(app))
            val web = File(app.filesDir, "web-${BuildConfig.VERSION_CODE}")
            fun copyAsset(name: String, destination: File) {
                val children = app.assets.list(name) ?: emptyArray()
                if (children.isEmpty()) {
                    destination.parentFile?.mkdirs()
                    app.assets.open(name).use { source -> destination.outputStream().use { source.copyTo(it) } }
                } else {
                    destination.mkdirs()
                    children.forEach { copyAsset("$name/$it", File(destination, it)) }
                }
            }
            if (!File(web, ".ready").exists()) {
                copyAsset("web", web)
                File(web, ".ready").writeText("ready")
            }
            Python.getInstance().getModule("android_backend").also {
                it.callAttr("start", File(app.filesDir, "library").absolutePath, web.absolutePath)
            }
        }
        startup = future
        return future
    }
}
