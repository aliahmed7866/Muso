package app.muso.player

import android.content.Context
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.JavaScriptSandbox
import java.util.concurrent.TimeUnit

/** Isolated JS engine: no DOM, network, filesystem or app bridge is exposed. */
object ChallengeRuntime {
    private lateinit var context: Context
    @JvmStatic fun initialize(value: Context) { context = value.applicationContext }
    @JvmStatic fun supported(): Boolean = JavaScriptSandbox.isSupported()
    @JvmStatic @Synchronized fun evaluate(source: String): String {
        require(source.length <= 12 * 1024 * 1024) { "Source script is too large" }
        check(supported()) { "Update Android System WebView to use online imports" }
        val sandbox = JavaScriptSandbox.createConnectedInstanceAsync(context).get(15, TimeUnit.SECONDS)
        try {
            val parameters = IsolateStartupParameters()
            if (sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) parameters.setMaxHeapSizeBytes(128L * 1024 * 1024)
            val isolate = sandbox.createIsolate(parameters)
            try {
                val wrapped = "var __musoOutput = []; globalThis.console = {log: function(x){__musoOutput.push(String(x));},warn:function(){},error:function(){}};\n" + source + "\n__musoOutput.join('\\n');"
                return isolate.evaluateJavaScriptAsync(wrapped).get(30, TimeUnit.SECONDS)
            } finally { isolate.close() }
        } finally { sandbox.close() }
    }
}
