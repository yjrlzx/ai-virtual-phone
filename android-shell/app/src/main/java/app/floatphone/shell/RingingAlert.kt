package app.floatphone.shell

import android.content.Context
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * 来电铃声+震动（微信式提醒）：
 * 播放系统默认来电铃声（循环）+ 循环振动（复用 CallAlert 的振动节奏），
 * 超时或 stopRing() 收场。与 CallAlert（纯振动）并存：ring() 可同时调它。
 */
object RingingAlert {

    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null
    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null

    @Volatile
    var ringing: Boolean = false
        private set

    private fun systemVibrator(context: Context): Vibrator? = runCatching {
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }.getOrNull()

    /** 开始响铃+震动。timeoutMs 秒后自动收场（默认 30s）。 */
    fun start(context: Context, timeoutMs: Long = 30_000L) {
        stop()
        ringing = true
        runCatching {
            val uri: Uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            if (uri != null) {
                val rt = RingtoneManager.getRingtone(context, uri)
                if (rt != null) {
                    rt.isLooping = true
                    rt.play()
                    ringtone = rt
                }
            }
        }
        val pattern = longArrayOf(0, 500, 250, 500, 1400)
        vibrator = systemVibrator(context)?.also { v ->
            runCatching {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(VibrationEffect.createWaveform(pattern, 1))
                } else {
                    @Suppress("DEPRECATION")
                    v.vibrate(pattern, 1)
                }
            }
        }
        val runnable = Runnable {
            timeoutRunnable = null
            stop()
        }
        timeoutRunnable = runnable
        handler.postDelayed(runnable, timeoutMs)
    }

    /** 收场：停铃声+停振动。 */
    fun stop() {
        ringing = false
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
        runCatching { ringtone?.stop() }
        runCatching { ringtone = null }
        runCatching { vibrator?.cancel() }
        vibrator = null
    }
}
