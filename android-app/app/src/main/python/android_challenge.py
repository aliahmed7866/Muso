"""A yt-dlp EJS provider backed by Android's isolated JavaScript engine."""
from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
from yt_dlp.extractor.youtube.jsc.provider import register_provider, register_preference, JsChallengeProviderError
from yt_dlp.extractor.youtube.pot._provider import BuiltinIEContentProvider


@register_provider
class AndroidJCP(EJSBaseJCP, BuiltinIEContentProvider):
    PROVIDER_NAME = 'android'
    JS_RUNTIME_NAME = 'android'

    def is_available(self):
        from java import jclass
        return self._available and jclass('app.muso.player.ChallengeRuntime').supported()

    def _run_js_runtime(self, source):
        from java import jclass
        try:
            return str(jclass('app.muso.player.ChallengeRuntime').evaluate(source))
        except Exception as exc:
            raise JsChallengeProviderError('The Android JavaScript engine could not process this source.') from exc


@register_preference(AndroidJCP)
def preference(provider, requests):
    return 1200
