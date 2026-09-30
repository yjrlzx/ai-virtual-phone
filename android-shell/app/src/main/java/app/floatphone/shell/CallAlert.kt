package app.floatphone.shell

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * 来电提示的共享状态：振动循环 + 铃声循环 + 超时未接。
 * 振动尊重系统响铃模式由系统 Vibrator 自行处理；铃声走 STREAM_RING 音量流，
 * 锁屏/熄屏也能响。任何一方（接听/拒接/超时/新来电顶替）调用 stop 即全部收场。
 */
object CallAlert {
    const val NOTIF_CALL_ID = 60
    const val NOTIF_MISSED_ID = 61
    const val TIMEOUT_MS = 55_000L

    private var vibrator: Vibrator? = null
    private var ringtone: Ringtone? = null
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null
    /** 当前振铃中的会话（IncomingCallActivity 读取；空表示没有活动来电） */
    @Volatile var activeSessionId: String = ""
    @Volatile var activeCharacterName: String = ""

    /**
     * 网页可配置的来电铃声 Uri。
     * null = 未设置（跟随系统默认来电铃声）；空串 = 只振动不响铃；非空 = 指定 Uri。
     */
    @Volatile
    var ringtoneUri: String? = null

    private fun systemVibrator(context: Context): Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }.getOrNull()

    /** 开始来电：循环振动 + 循环铃声 + 挂超时。已有来电时先收掉旧的。 */
    fun start(context: Context, sessionId: String, characterName: String, onTimeout: () -> Unit) {
        stop(context, cancelNotification = false)
        activeSessionId = sessionId
        activeCharacterName = characterName
        val pattern = longArrayOf(0, 500, 250, 500, 1400)
        vibrator = systemVibrator(context)?.also { v ->
            runCatching {
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(VibrationEffect.createWaveform(pattern, 1))
                } else {
                    @Suppress("DEPRECATION")
                    v.vibrate(pattern, 1)
                }
            }
        }
        playRingtone(context)
        val runnable = Runnable {
            timeoutRunnable = null
            runCatching { onTimeout() }
        }
        timeoutRunnable = runnable
        handler.postDelayed(runnable, TIMEOUT_MS)
    }

    /**
     * 循环播放来电铃声（STREAM_RING 音量流）。
     * ringtoneUri 为 null → 系统默认来电铃声；空串 → 不响铃只振动；非空 → 指定 Uri。
     */
    fun playRingtone(context: Context) {
        val configured = ringtoneUri
        if (configured != null && configured.isBlank()) return
        runCatching {
            val uri: Uri? = if (configured.isNullOrBlank()) {
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            } else {
                Uri.parse(configured)
            }
            if (uri == null) return@runCatching
            val rt = RingtoneManager.getRingtone(context, uri) ?: return@runCatching
            rt.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            rt.isLooping = true
            rt.play()
            ringtone = rt
        }
    }

    /** 停止铃声。 */
    fun stopRingtone() {
        runCatching { ringtone?.stop() }
        ringtone = null
    }

    /** 收场：停振动、停铃声、撤超时，可选把来电通知一并撤下。 */
    fun stop(context: Context, cancelNotification: Boolean = true) {
        activeSessionId = ""
        activeCharacterName = ""
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        runCatching { vibrator?.cancel() }
        vibrator = null
        stopRingtone()
        if (cancelNotification) {
            runCatching {
                context.getSystemService(NotificationManager::class.java).cancel(NOTIF_CALL_ID)
            }
        }
    }
}
