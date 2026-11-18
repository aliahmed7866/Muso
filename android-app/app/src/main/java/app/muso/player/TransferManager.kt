package app.muso.player

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** One transfer per process; durable status and staged input survive Activity recreation. */
object TransferManager {
    private val executor = Executors.newSingleThreadExecutor()
    private val active = setOf("choosing", "reading", "importing", "exporting", "saving")
    private var folder: File? = null
    private var state = JSONObject().put("phase", "idle")
    private val archive: File get() = File(folder!!, "selected.zip")

    @Synchronized fun initialize(context: Context) {
        if (folder != null) return
        folder = File(context.applicationContext.filesDir, "library/transfers").apply { mkdirs() }
        val status = AtomicFile(File(folder!!, "status.json"))
        state = try { JSONObject(String(status.readFully(), Charsets.UTF_8)) } catch (_: Exception) { JSONObject().put("phase", "idle") }
        if (state.optString("phase") in active) {
            state.put("phase", "interrupted").put("message", "Transfer interrupted. You can retry safely; songs already imported will be kept.")
        }
        File(folder!!, "copying.zip").delete()
        File(folder!!, "export.zip").delete()
        persist()
    }
    @Synchronized private fun persist() {
        val file = AtomicFile(File(folder!!, "status.json"))
        val stream = file.startWrite()
        try { stream.write(state.toString().toByteArray()); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
    @Synchronized private fun update(phase: String, message: String, data: JSONObject? = null) {
        state.put("phase", phase).put("message", message)
        if (data != null) for (key in data.keys()) state.put(key, data.get(key))
        persist()
    }
    @Synchronized fun status(): JSONObject = JSONObject(state.toString()).put("canRetry", archive.isFile && state.optString("kind") == "import")
    @Synchronized fun beginPicker(kind: String) {
        check(state.optString("phase") !in active) { "A transfer is already in progress" }
        state = JSONObject().put("phase", "choosing").put("kind", kind).put("message", "Choose a file location…")
        persist()
    }
    @Synchronized fun cancelled() { update("idle", "File selection cancelled.") }
    @Synchronized fun failed(error: Exception) { update("error", error.message ?: "Transfer could not finish. Please try again.") }
    @Synchronized fun discard() {
        check(state.optString("phase") !in active) { "Wait for this transfer to finish" }
        archive.delete()
        state = JSONObject().put("phase", "idle")
        persist()
    }
    /** Called from Python between songs. Do not write the journal on every progress tick. */
    @Synchronized fun report(raw: String) {
        val progress = JSONObject(raw)
        for (key in progress.keys()) state.put(key, progress.get(key))
    }
    fun select(context: Context, uri: Uri) {
        val app = context.applicationContext
        update("reading", "Reading your backup…", JSONObject().put("completed", 0).put("total", 0))
        executor.execute {
            val temp = File(folder!!, "copying.zip")
            try {
                var name = "Muso backup.zip"
                var size = 0L
                app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
                    if (it.moveToFirst()) { name = it.getString(0) ?: name; if (!it.isNull(1)) size = it.getLong(1) }
                }
                check(size <= 10L * 1024 * 1024 * 1024) { "Backup exceeds the 10 GB limit" }
                archive.delete()
                check(size + 100L * 1024 * 1024 < folder!!.usableSpace) { "Not enough free storage to read this backup" }
                update("reading", "Reading $name…", JSONObject().put("filename", name).put("totalBytes", size))
                val input = app.contentResolver.openInputStream(uri) ?: error("Could not open the selected file")
                input.use { source -> temp.outputStream().use { target ->
                    val buffer = ByteArray(1024 * 1024)
                    var copied = 0L
                    while (true) {
                        val count = source.read(buffer)
                        if (count < 0) break
                        copied += count
                        check(copied <= 10L * 1024 * 1024 * 1024) { "Backup exceeds the 10 GB limit" }
                        check(folder!!.usableSpace > count + 100L * 1024 * 1024) { "Not enough free storage to read this backup" }
                        target.write(buffer, 0, count)
                        report(JSONObject().put("copiedBytes", copied).toString())
                    }
                } }
                val backend = EmbeddedEngine.start(app).get()
                val preview = JSONObject(backend.callAttr("preview_backup", temp.absolutePath).toString())
                check(temp.renameTo(archive)) { "Could not stage the backup" }
                update("ready", "Review your backup before importing.", JSONObject().put("preview", preview))
            } catch (error: Exception) { temp.delete(); failed(error) }
        }
    }
    @Synchronized fun importSelected(context: Context) {
        check(state.optString("phase") !in active) { "A transfer is already in progress" }
        check(archive.isFile) { "Choose a backup ZIP first" }
        val app = context.applicationContext
        update("importing", "Preparing your music…", JSONObject().put("completed", 0).put("total", 0))
        executor.execute {
            try {
                val backend = EmbeddedEngine.start(app).get()
                val result = JSONObject(backend.callAttr("import_backup", archive.absolutePath, this).toString())
                if (result.getJSONArray("errors").length() == 0) archive.delete()
                update("done", "Library transfer finished.", JSONObject().put("result", result).put("kind", "import"))
            } catch (error: Exception) { failed(error) }
        }
    }
    fun save(context: Context, uri: Uri, kind: String) {
        val app = context.applicationContext
        update(if (kind == "tool") "saving" else "exporting", if (kind == "tool") "Saving the Termux export tool…" else "Preparing your backup…", JSONObject().put("completed", 0).put("total", 0).put("kind", kind))
        executor.execute {
            val temp = File(folder!!, "export.zip")
            try {
                if (kind == "tool") {
                    app.assets.open("web/transfer/Muso-transfer.py").use { input ->
                        (app.contentResolver.openOutputStream(uri, "wt") ?: error("Could not write the export tool")).use { input.copyTo(it) }
                    }
                    update("done", "Export tool saved. Run the command below in Termux.")
                } else {
                    temp.delete()
                    val backend = EmbeddedEngine.start(app).get()
                    val result = JSONObject(backend.callAttr("export_backup", temp.absolutePath, this).toString())
                    update("exporting", "Saving backup to your chosen location…")
                    temp.inputStream().use { input ->
                        (app.contentResolver.openOutputStream(uri, "wt") ?: error("Could not write the backup")).use { input.copyTo(it, 1024 * 1024) }
                    }
                    update("done", "Backup saved: ${result.getInt("tracks")} songs, playlists, likes and history.")
                }
            } catch (error: Exception) {
                try { DocumentsContract.deleteDocument(app.contentResolver, uri) } catch (_: Exception) { }
                failed(error)
            } finally { temp.delete() }
        }
    }
}
