package app.floatphone.shell

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * 语音转文字（STT）封装：
 *  - mode=system：系统 SpeechRecognizer（华为手机自带识别服务），异步回传文本；
 *  - mode=online：AudioRecord 录音 → 停止后组装 WAV → 上传可配的在线转写接口（OpenAI 兼容 multipart）。
 * 识别结果一律经 callback(json) 回传给网页（window.__floatBridgeOnSpeechText）。
 */
object ShellStt {

    private const val SAMPLE_RATE = 16000
    private val executor = Executors.newSingleThreadExecutor()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    @Volatile
    private var recognizer: SpeechRecognizer? = null
    @Volatile
    private var audioRecord: AudioRecord? = null
    private val recording = AtomicBoolean(false)
    private var mode = "system"
    private var onlineUrl = ""
    private var onlineKey = ""
    private var onlineModel = "whisper-1"
    private var callback: ((String) -> Unit)? = null
    private val pcmBuffer = java.util.concurrent.ConcurrentLinkedQueue<ShortArray>()

    /** 开始聆听。configJson: {mode, url, key, model} */
    fun start(context: Context, configJson: String, cb: (String) -> Unit) {
        callback = cb
        val cfg = runCatching { JSONObject(configJson) }.getOrElse { JSONObject() }
        mode = cfg.optString("mode", "system")
        onlineUrl = cfg.optString("url", "")
        onlineKey = cfg.optString("key", "")
        onlineModel = cfg.optString("model", "whisper-1").ifBlank { "whisper-1" }
        stopInternal()
        if (mode == "online") {
            startOnlineRecording()
        } else {
            startSystemRecognition(context)
        }
    }

    private fun startSystemRecognition(context: Context) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            callback?.invoke("""{"ok":false,"error":"当前系统不支持语音识别"}""")
            return
        }
        val rec = SpeechRecognizer.createSpeechRecognizer(context)
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onError(error: Int) {
                val msg = when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH -> "没有听清，请再试一次"
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有检测到语音"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "缺少麦克风权限"
                    SpeechRecognizer.ERROR_NETWORK -> "识别服务网络异常"
                    SpeechRecognizer.ERROR_CLIENT -> "识别服务暂时不可用"
                    else -> "语音识别失败（$error）"
                }
                callback?.invoke(JSONObject().put("ok", false).put("error", msg).toString())
                stopInternal()
            }
            override fun onResults(results: Bundle?) {
                val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = if (texts.isNullOrEmpty()) "" else texts[0]
                if (text.isBlank()) {
                    callback?.invoke("""{"ok":false,"error":"没有识别到内容"}""")
                } else {
                    callback?.invoke(JSONObject().put("ok", true).put("text", text).toString())
                }
                stopInternal()
            }
        })
        recognizer = rec
        val intent = android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        }
        runCatching { rec.startListening(intent) }
    }

    private fun startOnlineRecording() {
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val rec = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBuf * 2,
        )
        rec.startRecording()
        audioRecord = rec
        recording.set(true)
        executor.execute {
            val buf = ShortArray(4096)
            while (recording.get()) {
                val read = runCatching { rec.read(buf, 0, buf.size) }.getOrElse { -1 }
                if (read <= 0) continue
                pcmBuffer.add(buf.copyOf(read))
            }
        }
    }

    /** 结束聆听并出结果。 */
    fun stop() {
        stopInternal()
    }

    private fun stopInternal() {
        if (mode == "online") {
            recording.set(false)
            val rec = audioRecord
            audioRecord = null
            if (rec != null) {
                executor.execute {
                    runCatching { rec.stop() }
                    runCatching { rec.release() }
                    uploadAndRecognize()
                }
            }
        } else {
            runCatching { recognizer?.stopListening() }
            recognizer?.destroy()
            recognizer = null
        }
    }

    private fun uploadAndRecognize() {
        val chunks = ArrayList<ShortArray>()
        while (true) {
            val c = pcmBuffer.poll() ?: break
            chunks.add(c)
        }
        if (chunks.isEmpty()) {
            callback?.invoke("""{"ok":false,"error":"录音太短"}""")
            return
        }
        var total = 0
        for (c in chunks) total += c.size
        if (total < SAMPLE_RATE / 4) {
            callback?.invoke("""{"ok":false,"error":"说话时间太短"}""")
            return
        }
        val pcm = ShortArray(total)
        var off = 0
        for (c in chunks) {
            System.arraycopy(c, 0, pcm, off, c.size)
            off += c.size
        }
        val wav = buildWav(pcm)
        if (onlineUrl.isBlank()) {
            callback?.invoke("""{"ok":false,"error":"未配置在线转写地址"}""")
            return
        }
        try {
            val filePart = wav.toRequestBody("audio/wav".toMediaType())
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", "recording.wav", filePart)
                .addFormDataPart("model", onlineModel)
                .build()
            val req = Request.Builder()
                .url(onlineUrl)
                .header("Authorization", "Bearer $onlineKey")
                .post(body)
                .build()
            httpClient.newCall(req).execute().use { resp ->
                val text = resp.body?.string() ?: ""
                val parsed = runCatching { JSONObject(text) }
                    .getOrElse { runCatching { JSONObject(text.trim().removePrefix("[").removeSuffix("]")) }.getOrNull() }
                val result = parsed?.optString("text") ?: parsed?.optString("result")
                if (result.isNullOrBlank()) {
                    callback?.invoke(JSONObject().put("ok", false).put("error", "在线转写未返回文本").toString())
                } else {
                    callback?.invoke(JSONObject().put("ok", true).put("text", result.trim()).toString())
                }
            }
        } catch (e: Exception) {
            callback?.invoke(JSONObject().put("ok", false).put("error", "在线转写失败：${e.message}").toString())
        }
    }

    private fun buildWav(pcm: ShortArray): ByteArray {
        val dataSize = pcm.size * 2
        val out = ByteArrayOutputStream()
        fun writeLE(value: Int, bytes: Int) {
            for (i in 0 until bytes) out.write((value shr (i * 8)) and 0xFF)
        }
        out.write("RIFF".toByteArray())
        writeLE(36 + dataSize, 4)
        out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray())
        writeLE(16, 4)
        writeLE(1, 2)
        writeLE(1, 2)
        writeLE(SAMPLE_RATE, 4)
        writeLE(SAMPLE_RATE * 2, 4)
        writeLE(2, 2)
        writeLE(16, 2)
        out.write("data".toByteArray())
        writeLE(dataSize, 4)
        for (v in pcm) {
            out.write(v.toInt() and 0xFF)
            out.write((v.toInt() shr 8) and 0xFF)
        }
        return out.toByteArray()
    }
}
