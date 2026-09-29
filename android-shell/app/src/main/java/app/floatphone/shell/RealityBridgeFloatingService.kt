package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import androidx.core.app.NotificationCompat
import kotlin.math.hypot

/**
 * 现实桥·华为端悬浮球服务。
 *
 * 在真实屏幕边缘浮一个球，双击把当前真实屏幕截下来交给小手机角色速聊
 * （与 iOS 悬浮球双击速聊同构）。需要 悬浮窗 权限。
 */
class RealityBridgeFloatingService : Service() {

    companion object {
        private const val CH_FLOAT = "shell_float"
        private const val NOTIF_FG_ID = 2
        private const val DOUBLE_TAP_MS = 300L
        private const val MAX_TAP_DISTANCE = 60f

        fun start(context: Context) {
            val intent = Intent(context, RealityBridgeFloatingService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun canDrawOverlays(context: Context): Boolean =
            Settings.canDrawOverlays(context)
    }

    private var windowManager: WindowManager? = null
    private var ballView: View? = null
    private var lastTapAt = 0L
    private var lastTapX = 0f
    private var lastTapY = 0f
    private var downX = 0f
    private var downY = 0f

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIF_FG_ID, buildFloatNotification())
        if (!canDrawOverlays(this)) {
            // 引导去开悬浮窗权限
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            stopSelf()
            return
        }
        showBall()
    }

    private fun showBall() {
        val wm = getSystemService(WINDOW_SERVICE) as? WindowManager ?: return
        windowManager = wm
        val inflater = getSystemService(LAYOUT_INFLATER_SERVICE) as LayoutInflater
        val ball = ImageView(this)
        ball.setImageResource(R.drawable.ic_stat)
        ball.alpha = 0.92f
        val size = (46 * resources.displayMetrics.density).toInt()
        val params = WindowManager.LayoutParams(
            size, size,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = resources.displayMetrics.widthPixels - size - 24
            y = resources.displayMetrics.heightPixels / 3
        }

        var startRawX = 0
        var startRawY = 0
        var paramsX = 0
        var paramsY = 0
        var moved = false

        ball.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startRawX = event.rawX.toInt()
                    startRawY = event.rawY.toInt()
                    paramsX = params.x
                    paramsY = params.y
                    moved = false
                    downX = event.rawX
                    downY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - startRawX
                    val dy = event.rawY - startRawY
                    if (hypot(dx, dy) > 20f) moved = true
                    params.x = paramsX + dx.toInt()
                    params.y = paramsY + dy.toInt()
                    runCatching { wm.updateViewLayout(v, params) }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (moved) return@setOnTouchListener true
                    val now = System.currentTimeMillis()
                    val x = event.rawX
                    val y = event.rawY
                    val within = hypot(x - lastTapX, y - lastTapY) <= MAX_TAP_DISTANCE
                    val double = now - lastTapAt <= DOUBLE_TAP_MS && within
                    lastTapAt = now
                    lastTapX = x
                    lastTapY = y
                    if (double) onDoubleTap()
                    true
                }
                else -> false
            }
        }
        runCatching { wm.addView(ball, params) }
        ballView = ball
    }

    private fun onDoubleTap() {
        // 双击 → 截真实屏幕 → 交给角色速聊
        MediaProjectionCapture.capture(this) { bitmap ->
            if (bitmap != null) {
                // 借活动 MainActivity 的 AndroidShell 桥回调网页（网页侧 window.__floatBridgeOnScreenShot）
                MainActivity.deliverScreenShotToWeb(bitmap)
            } else if (MediaProjectionCapture.needsReauth) {
                // 投影为空/已失效：借活动切主线程弹系统授权，授权成功后 screenCaptureLauncher 会自动再截一次
                MainActivity.requestScreenCaptureForFloatingBall()
            }
            // busy（上一帧未拍完）导致的 null 直接忽略，不打扰用户
        }
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CH_FLOAT, "悬浮球", NotificationManager.IMPORTANCE_MIN).apply {
                description = "现实桥悬浮球服务（可在此关闭常驻通知显示）"
                setShowBadge(false)
            },
        )
    }

    private fun buildFloatNotification(): Notification =
        NotificationCompat.Builder(this, CH_FLOAT)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机 · 现实桥")
            .setContentText("悬浮球已就绪，双击截图速聊")
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
        runCatching { ballView?.let { windowManager?.removeView(it) } }
        ballView = null
        super.onDestroy()
    }
}
