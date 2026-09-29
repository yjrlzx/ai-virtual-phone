package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.Locale
import org.json.JSONObject

/**
 * 常驻麦克风唤醒服务（小艺式）：
 *  - mode=system：系统 SpeechRecognizer 连续识别，识别文本含唤醒词即触发（华为自带识别，可离线语音包）；
 *  - mode=on_device：端上 WakeWordDetector（能量 VAD + MFCC + DTW 模板），不占在线识别，需先登记唤醒词模板。
 * 触发后经 MainActivity.deliverWakeWordToWeb(json) 回传网页（window.__floatBridgeOnWakeWord）。
 * 前台服务类型 microphone，需用户手动开启（设置页开关，默认关）。
 */
class WakeWordService : Service() {

    companion object {
        private const val TAG = "WakeWordService"
        private const val CH_WAKE = "shell_wake"
        private const val NOTIF_ID = 70
        const val EXTRA_CONFIG = "config"
        const val ACTION_STOP = "app.floatphone.shell.WAKE_STOP"

        fun start(context: Context, configJson: String) {
            val intent = Intent(context, WakeWordService::class.java).putExtra(EXTRA_CONFIG, configJson)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, WakeWordService::class.java).setAction(ACTION_STOP))
        }
    }

    private var recognizer: SpeechRecognizer? = null
    private var detector: WakeWordDetector? = null
    private var detectorThread: Thread? = null
    private var wakeWord = ""
    private var mode = "system"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIF_ID, buildNotification())
        SpeechRecognizer.isRecognitionAvailable(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val configJson = intent?.getStringExtra(EXTRA_CONFIG)
        val cfg = runCatching { JSONObject(configJson) }.getOrElse { JSONObject() }
        wakeWord = cfg.optString("wakeWord", "").trim()
        mode = cfg.optString("mode", "system")
        stopWorkers()
        if (wakeWord.isBlank() && mode != "on_device") {
            // on_device 不需要文本唤醒词（用模板匹配），system 模式必须有文本
            stopSelf()
            return START_NOT_STICKY
        }
        if (mode == "on_device") {
            startOnDevice()
        } else {
            startSystemMode()
        }
        return START_STICKY
    }

    private fun startSystemMode() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            MainActivity.deliverWakeWordToWeb(JSONObject().put("ok", false).put("error", "系统识别服务不可用").toString())
            stopSelf()
            return
        }
        val rec = SpeechRecognizer.createSpeechRecognizer(this)
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onError(error: Int) {
                // 无匹配/超时/网络抖动都重启监听；权限缺失才停
                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                    MainActivity.deliverWakeWordToWeb(JSONObject().put("ok", false).put("error", "缺少麦克风权限").toString())
                    stopSelf()
                    return
                }
                restartSystemMode()
            }
            override fun onResults(results: Bundle?) {
                val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = if (texts.isNullOrEmpty()) "" else texts.joinToString("")
                if (text.isNotEmpty() && text.contains(wakeWord)) {
                    MainActivity.deliverWakeWordToWeb(
                        JSONObject().put("ok", true).put("matched", wakeWord).put("text", text).toString(),
                    )
                }
                restartSystemMode()
            }
        })
        recognizer = rec
        startRecognition()
    }

    private fun startRecognition() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        runCatching { recognizer?.startListening(intent) }
    }

    private fun restartSystemMode() {
        if (recognizer == null) return
        runCatching { recognizer?.cancel() }
        startRecognition()
    }

    private fun startOnDevice() {
        val templates = WakeWordDetector.loadTemplates(this)
        if (templates.isEmpty()) {
            MainActivity.deliverWakeWordToWeb(
                JSONObject().put("ok", false).put("error", "还没有登记唤醒词模板，请先在设置页录制").toString(),
            )
            stopSelf()
            return
        }
        val det = WakeWordDetector(this) { similarity ->
            MainActivity.deliverWakeWordToWeb(
                JSONObject().put("ok", true).put("mode", "on_device").put("similarity", similarity).toString(),
            )
        }
        detector = det
        detectorThread = Thread {
            det.runLoop()
        }.also { it.start() }
    }

    private fun stopWorkers() {
        runCatching { recognizer?.cancel() }
        runCatching { recognizer?.destroy() }
        recognizer = null
        runCatching { detector?.stop() }
        detector = null
        detectorThread?.interrupt()
        detectorThread = null
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CH_WAKE, "语音唤醒", NotificationManager.IMPORTANCE_MIN).apply {
                description = "常驻麦克风监听唤醒词（可在设置页关闭）"
                setShowBadge(false)
            },
        )
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CH_WAKE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("语音唤醒已开启")
            .setContentText("说唤醒词即可唤起小手机")
            .setOngoing(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, 0,
                    Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()

    override fun onDestroy() {
        stopWorkers()
        super.onDestroy()
    }
}