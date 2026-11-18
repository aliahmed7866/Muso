package app.muso.player

import android.content.ComponentName
import android.os.Bundle
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import java.util.concurrent.CountDownLatch
import android.os.ParcelFileDescriptor
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import org.hamcrest.Matchers.containsString
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import kotlin.math.sin

@androidx.media3.common.util.UnstableApi
@RunWith(AndroidJUnit4::class)
class AndroidPlayerTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private fun <T> main(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST") return result as T
    }
    private fun waitFor(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 15000
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(100)
        }
        assertTrue("Condition did not become true", predicate())
    }
    private fun screenshot(name: String, scenario: ActivityScenario<MainActivity>) {
        // DOM assertions can complete before Chromium has committed its next visual frame.
        val frame = CountDownLatch(1)
        scenario.onActivity { activity ->
            fun findWeb(view: View): WebView? {
                if (view is WebView) return view
                if (view is ViewGroup) for (index in 0 until view.childCount) findWeb(view.getChildAt(index))?.let { return it }
                return null
            }
            val web = findWeb(activity.window.decorView)!!
            web.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) { web.postDelayed({ frame.countDown() }, 250) }
            })
        }
        assertTrue("WebView did not commit its visual frame", frame.await(10, TimeUnit.SECONDS))
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("screencap -p /sdcard/Download/muso-$name.png")).use { it.readBytes() }
    }
    private fun wav(name: String, seconds: Int, frequency: Double): File {
        val samples = 22050 * seconds
        val data = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN)
        data.put("RIFF".toByteArray()).putInt(36 + samples * 2).put("WAVEfmt ".toByteArray())
        data.putInt(16).putShort(1).putShort(1).putInt(22050).putInt(44100).putShort(2).putShort(16)
        data.put("data".toByteArray()).putInt(samples * 2)
        for (i in 0 until samples) data.putShort((sin(i * frequency * 2 * Math.PI / 22050) * 1000).toInt().toShort())
        return File(context.filesDir, "library/imports/$name.wav").apply { parentFile!!.mkdirs(); writeBytes(data.array()) }
    }
    @Test fun fullAppAndNativeBackgroundQueue() {
        val backend = EmbeddedEngine.start(context).get(60, TimeUnit.SECONDS)
        assertTrue(ChallengeRuntime.supported())
        assertEquals("42", ChallengeRuntime.evaluate("console.log(6 * 7)"))
        val first = wav("Android first", 2, 440.0)
        val second = wav("Android second", 30, 880.0)
        val id1 = JSONObject(backend.callAttr("import_file", first.absolutePath, first.name).toString()).getString("id")
        val id2 = JSONObject(backend.callAttr("import_file", second.absolutePath, second.name).toString()).getString("id")
        val ids = JSONArray().put(id1).put(id2)
        val items = JSONArray(backend.callAttr("items", ids.toString()).toString())
        assertEquals(2, items.length())
        val playlist = JSONObject(backend.callAttr("api", "/api/playlists", "POST", JSONObject().put("name", "Android test").put("tracks", ids).toString()).toString())
        assertEquals(201, playlist.getInt("status"))
        val html = backend.callAttr("asset", "/").asList()[1].toJava(ByteArray::class.java).toString(Charsets.UTF_8)
        assertTrue(html.contains("/static/android.js"))
        assertTrue(html.contains("Recap"))
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            waitFor {
                try {
                    onWebView().withElement(findElement(Locator.ID, "status")).check(webMatches(getText(), containsString("On this device")))
                    true
                } catch (_: Throwable) { false }
            }
            screenshot("library", scenario)
            val future = main { MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync() }
            val controller = future.get(30, TimeUnit.SECONDS)
            fun command(request: JSONObject): JSONObject {
                val response = main { controller.sendCustomCommand(SessionCommand(PlaybackService.COMMAND, Bundle.EMPTY), Bundle().apply { putString("json", request.toString()) }) }.get(15, TimeUnit.SECONDS)
                assertEquals(0, response.resultCode)
                return JSONObject(response.extras.getString("json")!!)
            }
            fun state() = command(JSONObject().put("op", "state"))
            command(JSONObject().put("op", "load").put("items", items).put("current", id1).put("repeat", 0))
            waitFor { main { controller.isPlaying } }
            // Stop the Activity's visible lifecycle: the service must own the next track.
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            waitFor { state().optString("current") == id2 && state().optDouble("position") > 0.2 }
            val before = state().getDouble("position")
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            scenario.recreate()
            assertEquals(id2, state().getString("current"))
            assertTrue(state().getDouble("position") >= before)
            waitFor {
                try {
                    onWebView().withElement(findElement(Locator.ID, "now-title")).check(webMatches(getText(), containsString("Android second")))
                    true
                } catch (_: Throwable) { false }
            }
            onWebView().withElement(findElement(Locator.ID, "now")).perform(webClick())
            waitFor {
                try {
                    onWebView().withElement(findElement(Locator.ID, "np-title")).check(webMatches(getText(), containsString("Android second")))
                    true
                } catch (_: Throwable) { false }
            }
            screenshot("now-playing", scenario)
            command(JSONObject().put("op", "seek").put("seconds", 5))
            waitFor { state().getDouble("position") >= 5 }
            command(JSONObject().put("op", "queue").put("items", items).put("current", id2).put("repeat", 2))
            assertEquals(2, state().getInt("repeat"))
            command(JSONObject().put("op", "sleep").put("until", System.currentTimeMillis() + 1000))
            waitFor { !state().getBoolean("playing") }
            assertEquals(0L, state().getLong("sleepUntil"))
            main { controller.release() }
            onWebView().withElement(findElement(Locator.ID, "close")).perform(webClick())
            onWebView().withElement(findElement(Locator.ID, "add")).perform(webClick())
            onWebView().withElement(findElement(Locator.XPATH, "//button[text()='Transfer & backup']")).perform(webClick())
            waitFor {
                try {
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".transfer-guide")).check(webMatches(getText(), containsString("Save the export tool")))
                    true
                } catch (_: Throwable) { false }
            }
            screenshot("transfer-guide", scenario)
            val source = File(context.filesDir, "library/transfers/fixture.zip")
            source.delete()
            assertEquals(2, JSONObject(backend.callAttr("export_backup", source.absolutePath).toString()).getInt("tracks"))
            TransferManager.beginPicker("import")
            TransferManager.select(context, Uri.fromFile(source))
            waitFor { TransferManager.status().optString("phase") == "ready" }
            assertEquals(2, TransferManager.status().getJSONObject("preview").getInt("tracks"))
            scenario.recreate()
            waitFor {
                try {
                    onWebView().withElement(findElement(Locator.ID, "status")).check(webMatches(getText(), containsString("On this device")))
                    true
                } catch (_: Throwable) { false }
            }
            onWebView().withElement(findElement(Locator.ID, "add")).perform(webClick())
            onWebView().withElement(findElement(Locator.XPATH, "//button[text()='Transfer & backup']")).perform(webClick())
            waitFor {
                try {
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".transfer-stats")).check(webMatches(getText(), containsString("Songs")))
                    true
                } catch (_: Throwable) { false }
            }
            screenshot("transfer-preview", scenario)
            onWebView().withElement(findElement(Locator.XPATH, "//button[text()='Import into Muso']")).perform(webClick())
            waitFor { TransferManager.status().optString("phase") == "done" }
            val restored = TransferManager.status().getJSONObject("result")
            assertEquals(0, restored.getInt("saved"))
            assertEquals(2, restored.getInt("duplicates"))
            assertEquals(0, restored.getJSONArray("errors").length())
            waitFor {
                try {
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".transfer-live")).check(webMatches(getText(), containsString("2 already saved")))
                    true
                } catch (_: Throwable) { false }
            }
            screenshot("transfer-result", scenario)
            val tool = File(context.filesDir, "export-tool.py")
            TransferManager.beginPicker("tool")
            TransferManager.save(context, Uri.fromFile(tool), "tool")
            waitFor { TransferManager.status().optString("phase") == "done" }
            assertTrue(tool.readText().contains("def find_termux_library"))
            val output = File(context.filesDir, "exported-library.zip")
            TransferManager.beginPicker("export")
            TransferManager.save(context, Uri.fromFile(output), "export")
            waitFor { TransferManager.status().optString("phase") == "done" }
            assertTrue(output.length() > 0)
            java.util.zip.ZipFile(output).use { assertNotNull(it.getEntry("muso-backup.json")) }
            source.delete(); tool.delete(); output.delete()
        } finally { scenario.close() }
    }
}
