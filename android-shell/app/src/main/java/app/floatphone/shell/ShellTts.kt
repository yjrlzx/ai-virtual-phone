package app.floatphone.shell

import android.content.Context
import android.os.Bundle
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import org.json.JSONObject

/**
 * 文本朗读（TTS）队列封装：
 *  - 包装系统 TextToSpeech（华为小艺引擎由系统自动选中，只用公开 API）；
 *  - 内部 ArrayDeque 依次朗读；queue=false 时先打断当前并清空队列再播；
 *  - 每句开始/结束、队列播完、出错分别经 eventCallback(json) 回传网页
 *    （window.__floatBridgeOnTtsEvent）。
 * 朗读期间持有 PARTIAL_WAKE_LOCK（tag "float:tts"），保证灭屏不被系统挂起；队列空即释放。
 * 全程 runCatching 兜底，任何异常走 error 回调，不崩。
 */
object ShellTts {

    private const val WAKELOCK_TAG = "float:tts"

    @Volatile private var tts: TextToSpeech? = null
    @Volatile private var appCtx: Context? = null
    @Volatile private var initialized = false
    @Volatile private var speaking = false
    @Volatile private var currentSeq = -1
    @Volatile private var currentText = ""
    @Volatile private var nextSeq = 0
    @Volatile private var wakeLock: PowerManager.WakeLock? = null
    private val queue = ArrayDeque<QueuedItem>()
    private val lock = Any()
    private var eventCallback: ((String) -> Unit)? = null

    private data class QueuedItem(
        val text: String,
        val rate: Float,
        val pitch: Float,
        val languageTag: String,
    )

    /** 绑定上下文与网页回传回调（幂等：重复调用只刷新回调）。 */
    fun attach(context: Context, cb: (String) -> Unit) {
        eventCallback = cb
        appCtx = context.applicationContext
        ensureEngine()
    }

    private fun ensureEngine() {
        val ctx = appCtx ?: return
        if (tts != null) return
        tts = TextToSpeech(ctx) { status ->
            runCatching {
                if (status != TextToSpeech.SUCCESS) {
                    emitError("TTS 引擎初始化失败（status=$status）")
                    return@runCatching
                }
                val t = tts ?: return@runCatching
                t.setOnUtteranceProgressListener(progressListener)
                initialized = true
                maybeStartNext()
            }
        }
    }

    /** 入队朗读。interrupt=true 先打断当前并清空队列再播；false 追加到队尾依次播。 */
    fun speak(text: String, interrupt: Boolean, rate: Float, pitch: Float, languageTag: String) {
        ensureEngine()
        if (interrupt) {
            synchronized(lock) {
                queue.clear()
                currentSeq = -1
                speaking = false
            }
            runCatching { tts?.stop() }
        }
        synchronized(lock) {
            queue.addLast(QueuedItem(text, rate, pitch, languageTag))
        }
        maybeStartNext()
    }

    /** 清空队列并立即停止当前朗读。 */
    fun stop() {
        runCatching { tts?.stop() }
        synchronized(lock) {
            queue.clear()
            currentSeq = -1
            speaking = false
        }
        releaseWakeLock()
    }

    /** 状态快照：是否朗读中、队列长度、当前引擎包名（未初始化为 ""）。 */
    fun status(): JSONObject {
        val engine = runCatching {
            if (initialized) tts?.defaultEngine ?: "" else ""
        }.getOrDefault("")
        return JSONObject()
            .put("ok", true)
            .put("speaking", speaking)
            .put("queueLength", synchronized(lock) { queue.size })
            .put("engine", engine)
    }

    /** 销毁：关闭引擎、清队列、释 wakelock。 */
    fun destroy() {
        stop()
        runCatching { tts?.shutdown() }
        tts = null
        initialized = false
        eventCallback = null
        releaseWakeLock()
    }

    private fun maybeStartNext() {
        if (!initialized) return
        val item: QueuedItem? = synchronized(lock) {
            if (speaking) {
                null
            } else if (queue.isEmpty()) {
                null
            } else {
                queue.removeFirst()
            }
        }
        if (item == null) return
        runCatching {
            val t = tts ?: throw IllegalStateException("TTS 未就绪")
            applyLanguage(item.languageTag)
            t.setSpeechRate(item.rate)
            t.setPitch(item.pitch)
            val seq = nextSeq++
            val id = "u$seq"
            synchronized(lock) {
                speaking = true
                currentSeq = seq
                currentText = item.text
            }
            acquireWakeLock()
            t.speak(item.text, TextToSpeech.QUEUE_FLUSH, Bundle(), id)
        }.onFailure { emitError(it.message) }
    }

    /** 按 languageTag 设置发音；不支持时回退中文。 */
    private fun applyLanguage(tag: String) {
        runCatching {
            val t = tts ?: return@runCatching
            val loc = runCatching { Locale.forLanguageTag(tag) }.getOrDefault(Locale.CHINESE)
            val avail = t.isLanguageAvailable(loc)
            if (avail >= TextToSpeech.LANG_AVAILABLE) t.language = loc
            else t.language = Locale.CHINESE
        }
    }

    private val progressListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            if (utteranceId != "u$currentSeq") return
            emitEvent(JSONObject().put("type", "start").put("text", currentText).toString())
        }

        override fun onDone(utteranceId: String?) {
            if (utteranceId != "u$currentSeq") return
            val doneText = currentText
            synchronized(lock) {
                speaking = false
                currentSeq = -1
            }
            emitEvent(
                JSONObject().put("type", "utteranceDone").put("text", doneText).toString(),
            )
            val hasMore = synchronized(lock) { queue.isNotEmpty() }
            if (!hasMore) {
                releaseWakeLock()
                emitEvent(JSONObject().put("type", "queueDrained").toString())
            }
            maybeStartNext()
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            onError(utteranceId, -1)
        }

        override fun onError(utteranceId: String?, errorCode: Int) {
            if (utteranceId != "u$currentSeq") return
            synchronized(lock) {
                speaking = false
                currentSeq = -1
            }
            emitEvent(
                JSONObject().put("type", "error").put("error", "朗读失败（$errorCode）").toString(),
            )
            maybeStartNext()
        }
    }

    private fun acquireWakeLock() {
        runCatching {
            if (wakeLock?.isHeld == true) return@runCatching
            val pm = appCtx?.getSystemService(Context.POWER_SERVICE) as? PowerManager
                ?: return@runCatching
            val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG)
            wl.setReferenceCounted(false)
            wl.acquire(10 * 60 * 1000L)
            wakeLock = wl
        }
    }

    private fun releaseWakeLock() {
        runCatching {
            wakeLock?.takeIf { it.isHeld }?.release()
            wakeLock = null
        }
    }

    private fun emitEvent(json: String) {
        runCatching { eventCallback?.invoke(json) }
    }

    private fun emitError(msg: String?) {
        emitEvent(
            JSONObject().put("type", "error").put("error", msg ?: "TTS 出错").toString(),
        )
    }
}
