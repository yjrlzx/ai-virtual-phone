package app.floatphone.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * 来电铃声+震动的测试桥（ring()/stopRing()）。
 * 铃声循环复用 CallAlert.playRingtone/stopRingtone（真正的来电也走这套，
 * 不保留第二份铃声逻辑）；这里只额外跑一个振动循环 + 超时收场，供网页测试。
 */
object RingingAlert {

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

    /** 开始响铃+震动。timeoutMs 毫秒后自动收场（默认 30s）。 */
    fun start(context: Context, timeoutMs: Long = 30_000L) {
        stop()
        ringing = true
        CallAlert.playRingtone(context)
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
        CallAlert.stopRingtone()
        runCatching { vibrator?.cancel() }
        vibrator = null
    }
}
