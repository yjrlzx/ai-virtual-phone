package app.floatphone.shell

import android.content.Context
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * 文本朗读（TTS）队列封装：
 *  - 配置了 apiKey 时走 MiniMax t2a_v2 在线合成 mp3，后台线程请求、MediaPlayer 播放；
 *  - apiKey 为空时回退系统 TextToSpeech（华为小艺引擎由系统自动选中，只用公开 API）；
 *  - 内部 ArrayDeque 依次朗读；queue=false 时先打断当前并清空队列再播；
 *  - 每句开始/结束、队列播完、出错分别经 eventCallback(json) 回传网页
 *    （window.__floatBridgeOnTtsEvent）。
 * 朗读期间持有 PARTIAL_WAKE_LOCK（tag "float:tts"），保证灭屏不被系统挂起；队列空即释放。
 * 全程 runCatching 兜底，任何异常走 error 回调，不崩。
 */
object ShellTts {

    private const val WAKELOCK_TAG = "float:tts"
    private const val DEFAULT_BASE_URL = "https://api.minimaxi.com/v1"
    private const val DEFAULT_MODEL = "speech-01-turbo"

    @Volatile private var tts: TextToSpeech? = null
    @Volatile private var appCtx: Context? = null
    @Volatile private var initialized = false
    @Volatile private var speaking = false
    @Volatile private var currentSeq = -1
    @Volatile private var currentText = ""
    @Volatile private var nextSeq = 0
    @Volatile private var wakeLock: PowerManager.WakeLock? = null
    @Volatile private var currentCall: Call? = null
    @Volatile private var currentPlayer: MediaPlayer? = null
    private val queue = ArrayDeque<QueuedItem>()
    private val lock = Any()
    private var eventCallback: ((String) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val netExecutor = Executors.newSingleThreadExecutor()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private data class QueuedItem(
        val text: String,
        val rate: Float,
        val pitch: Float,
        val languageTag: String,
        val apiKey: String,
        val voiceId: String,
        val baseUrl: String,
        val model: String,
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

    /**
     * 入队朗读。interrupt=true 先打断当前并清空队列再播；false 追加到队尾依次播。
     * apiKey/voiceId/baseUrl/model 非空时走 MiniMax 在线合成，否则用系统 TTS。
     */
    fun speak(
        text: String,
        interrupt: Boolean,
        rate: Float,
        pitch: Float,
        languageTag: String,
        apiKey: String = "",
        voiceId: String = "",
        baseUrl: String = "",
        model: String = "",
    ) {
        ensureEngine()
        if (interrupt) {
            synchronized(lock) {
                queue.clear()
                currentSeq = -1
                speaking = false
            }
            runCatching { tts?.stop() }
            runCatching { currentCall?.cancel() }
            releasePlayer()
        }
        synchronized(lock) {
            queue.addLast(QueuedItem(text, rate, pitch, languageTag, apiKey, voiceId, baseUrl, model))
        }
        maybeStartNext()
    }

    /** 清空队列并立即停止当前朗读。 */
    fun stop() {
        runCatching { tts?.stop() }
        runCatching { currentCall?.cancel() }
        releasePlayer()
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
        val online = item.apiKey.isNotBlank()
        if (!online && !initialized) {
            // 系统引擎还没 init 完：放回队首，onInit 成功会再触发 maybeStartNext
            synchronized(lock) { queue.addFirst(item) }
            return
        }
        runCatching {
            val seq = nextSeq++
            synchronized(lock) {
                speaking = true
                currentSeq = seq
                currentText = item.text
            }
            acquireWakeLock()
            if (online) {
                startOnlinePlayback(item, seq)
            } else {
                val t = tts ?: throw IllegalStateException("TTS 未就绪")
                applyLanguage(item.languageTag)
                t.setSpeechRate(item.rate)
                t.setPitch(item.pitch)
                t.speak(item.text, TextToSpeech.QUEUE_FLUSH, Bundle(), "u$seq")
            }
        }.onFailure {
            synchronized(lock) {
                speaking = false
                currentSeq = -1
            }
            emitError(it.message)
            val hasMore = synchronized(lock) { queue.isNotEmpty() }
            if (!hasMore) {
                releaseWakeLock()
                emitEvent(JSONObject().put("type", "queueDrained").toString())
            }
            maybeStartNext()
        }
    }

    // ---- MiniMax 在线合成 ----

    private fun startOnlinePlayback(item: QueuedItem, seq: Int) {
        netExecutor.execute {
            val result = runCatching { synthesizeMiniMax(item) }
            mainHandler.post {
                if (currentSeq != seq) return@post
                result.onSuccess { mp3 -> playOnlineMp3(mp3, seq, item.text) }
                    .onFailure { finishOnline(seq, "在线语音合成失败：${it.message ?: "未知错误"}") }
            }
        }
    }

    private fun synthesizeMiniMax(item: QueuedItem): ByteArray {
        if (item.voiceId.isBlank()) throw IllegalStateException("未配置 voiceId")
        val base = item.baseUrl.ifBlank { DEFAULT_BASE_URL }.trimEnd('/')
        val voiceSetting = JSONObject()
            .put("voice_id", item.voiceId)
            .put("speed", item.rate.coerceIn(0.5f, 2.0f).toDouble())
            .put("vol", 1.0)
            .put("pitch", ((item.pitch - 1f) * 12f).toFloat().coerceIn(-12f, 12f).toDouble())
        val audioSetting = JSONObject()
            .put("sample_rate", 44100)
            .put("bitrate", 256000)
            .put("format", "mp3")
            .put("channel", 1)
        val reqBody = JSONObject()
            .put("model", item.model.ifBlank { DEFAULT_MODEL })
            .put("text", item.text)
            .put("stream", false)
            .put("voice_setting", voiceSetting)
            .put("audio_setting", audioSetting)
            .toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        val req = Request.Builder()
            .url("$base/t2a_v2")
            .header("Authorization", "Bearer ${item.apiKey}")
            .post(reqBody)
            .build()
        val call = httpClient.newCall(req)
        currentCall = call
        try {
            call.execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                val json = runCatching { JSONObject(raw) }
                    .getOrElse { throw IllegalStateException("返回解析失败：${raw.take(120)}") }
                val baseResp = json.optJSONObject("base_resp")
                val statusCode = baseResp?.optInt("status_code", 0) ?: 0
                if (!resp.isSuccessful || statusCode != 0) {
                    val msg = baseResp?.optString("status_msg")
                        ?.takeIf { it.isNotBlank() } ?: raw.take(120)
                    throw IllegalStateException("HTTP ${resp.code}：$msg")
                }
                val hex = json.optJSONObject("data")?.optString("audio")
                    ?.takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("返回中没有音频数据")
                return hexToBytes(hex)
            }
        } finally {
            if (currentCall === call) currentCall = null
        }
    }

    /** MediaPlayer 回调须跑在带 Looper 的线程（主线程）。 */
    private fun playOnlineMp3(mp3: ByteArray, seq: Int, text: String) {
        val ctx = appCtx ?: run {
            finishOnline(seq, "TTS 上下文缺失")
            return
        }
        val tmp = runCatching { File.createTempFile("minimax_", ".mp3", ctx.cacheDir) }
            .getOrElse {
                finishOnline(seq, "创建临时音频失败：${it.message}")
                return
            }
        runCatching { tmp.outputStream().use { it.write(mp3) } }
            .onFailure {
                tmp.delete()
                finishOnline(seq, "写入音频失败：${it.message}")
                return
            }
        val player = MediaPlayer()
        currentPlayer = player
        player.setOnPreparedListener {
            if (currentSeq != seq) {
                runCatching { it.release() }
                return@setOnPreparedListener
            }
            emitEvent(JSONObject().put("type", "start").put("text", text).toString())
            runCatching { it.start() }
        }
        player.setOnCompletionListener {
            runCatching { it.release() }
            if (currentPlayer === player) currentPlayer = null
            tmp.delete()
            if (currentSeq == seq) finishOnline(seq, null)
        }
        player.setOnErrorListener { _, what, extra ->
            runCatching { player.release() }
            if (currentPlayer === player) currentPlayer = null
            tmp.delete()
            if (currentSeq == seq) finishOnline(seq, "在线音频播放失败（$what/$extra）")
            true
        }
        runCatching {
            player.setDataSource(tmp.absolutePath)
            player.prepareAsync()
        }.onFailure {
            runCatching { player.release() }
            if (currentPlayer === player) currentPlayer = null
            tmp.delete()
            finishOnline(seq, "在线音频初始化失败：${it.message}")
        }
    }

    private fun finishOnline(seq: Int, error: String?) {
        if (currentSeq != seq) return
        val doneText = currentText
        synchronized(lock) {
            speaking = false
            currentSeq = -1
        }
        if (error != null) {
            emitEvent(JSONObject().put("type", "error").put("error", error).toString())
        } else {
            emitEvent(JSONObject().put("type", "utteranceDone").put("text", doneText).toString())
        }
        val hasMore = synchronized(lock) { queue.isNotEmpty() }
        if (!hasMore) {
            releaseWakeLock()
            emitEvent(JSONObject().put("type", "queueDrained").toString())
        }
        maybeStartNext()
    }

    private fun releasePlayer() {
        runCatching { currentPlayer?.stop() }
        runCatching { currentPlayer?.release() }
        currentPlayer = null
    }

    private fun hexToBytes(hex: String): ByteArray {
        val clean = hex.trim()
        val out = ByteArray(clean.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(clean[i * 2], 16)
            val lo = Character.digit(clean[i * 2 + 1], 16)
            out[i] = ((hi shl 4) + lo).toByte()
        }
        return out
    }

    // ---- 系统 TTS 兜底（行为与原实现一致） ----

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
