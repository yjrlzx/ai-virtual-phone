package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.Toast
import androidx.core.app.NotificationCompat
import kotlin.math.hypot

/**
 * 现实桥·悬浮球服务（对齐 Operit 悬浮球交互）。
 *
 *  - 单击（短按未拖动）→ 打开/收起悬浮聊天小窗（FloatingChatWindowService）；
 *  - 双击 → 无障碍遍历当前屏幕抓文字，塞进悬浮对话窗发给角色；无障碍未开时引导去开启；
 *  - 长按（超过 600ms 未拖动）→ 震动反馈并直接开始语音听写，结果填进悬浮窗输入框；
 *  - 拖动松手后自动吸附到最近的屏幕左/右边缘。
 *
 * 球上叠两个头像：主圆 = 角色头像（MascotAvatar），右下角小圆标 = 用户头像（未配置时显示默认图标）。
 * 球初始贴右边缘、位于状态栏下方；需要 悬浮窗 权限。
 */
class RealityBridgeFloatingService : Service() {

    companion object {
        private const val CH_FLOAT = "shell_float"
        private const val NOTIF_FG_ID = 2
        private const val DOUBLE_TAP_MS = 300L
        private const val MAX_TAP_DISTANCE = 60f
        private const val LONG_PRESS_MS = 600L
        private const val MOVE_SLOP = 20f

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
    private var ballParams: WindowManager.LayoutParams? = null
    private var ballPx = 0
    private var ballAvatarObserver: (() -> Unit)? = null
    private var badgeView: ImageView? = null
    private var mainAvatarView: ImageView? = null

    private val handler = Handler(Looper.getMainLooper())
    private var longPressRunnable: Runnable? = null
    private var longFired = false

    private var lastTapAt = 0L
    private var lastTapX = 0f
    private var lastTapY = 0f

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        MascotAvatar.initFromPrefs(this)
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

    private fun dp(v: Float): Int = (v * resources.displayMetrics.density).toInt()

    private fun showBall() {
        val wm = getSystemService(WINDOW_SERVICE) as? WindowManager ?: return
        windowManager = wm

        // 球：FrameLayout 叠两层 —— 主圆（角色头像，蓝底白描边）+ 右下角小圆标（用户头像）
        val ball = android.widget.FrameLayout(this)
        val mainAvatar = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFF4F8CFF.toInt())
                setStroke(dp(2f).toInt(), android.graphics.Color.WHITE)
            }
            alpha = 0.95f
        }
        ball.addView(mainAvatar, android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        // 右下角用户头像角标：白描边区分于主圆；无用户头像时显示灰色默认小圆
        val badge = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFF8A93A0.toInt())
                setStroke(dp(1.5f).toInt(), android.graphics.Color.WHITE)
            }
        }
        badgeView = badge
        val badgeSize = dp(18f)
        ball.addView(badge, android.widget.FrameLayout.LayoutParams(
            badgeSize, badgeSize, Gravity.BOTTOM or Gravity.END,
        ))
        mainAvatarView = mainAvatar
        applyBallAvatar()
        val observer: () -> Unit = { applyBallAvatar() }
        ballAvatarObserver = observer
        MascotAvatar.addObserver(observer)
        ballPx = dp(46f)
        val size = ballPx
        val params = WindowManager.LayoutParams(
            size, size,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // 初始靠右边缘、状态栏下方，避免被系统栏压住
            x = resources.displayMetrics.widthPixels - size - dp(16f)
            y = dp(120f)
        }
        ballParams = params

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
                    longFired = false
                    // 长按：600ms 内没有拖动 → 开始语音听写
                    val lp = Runnable {
                        if (!moved) {
                            longFired = true
                            onLongPress()
                        }
                    }
                    longPressRunnable = lp
                    handler.postDelayed(lp, LONG_PRESS_MS)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - startRawX
                    val dy = event.rawY - startRawY
                    if (hypot(dx, dy) > MOVE_SLOP) {
                        moved = true
                        handler.removeCallbacksAndLp()
                    }
                    if (moved) {
                        params.x = paramsX + dx.toInt()
                        params.y = paramsY + dy.toInt()
                        runCatching { wm.updateViewLayout(v, params) }
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    handler.removeCallbacksAndLp()
                    if (moved) {
                        snapToEdge()
                        return@setOnTouchListener true
                    }
                    if (longFired) {
                        longFired = false
                        return@setOnTouchListener true
                    }
                    // 未拖动、未长按：判定单击 / 双击
                    val now = System.currentTimeMillis()
                    val x = event.rawX
                    val y = event.rawY
                    val within = hypot(x - lastTapX, y - lastTapY) <= MAX_TAP_DISTANCE
                    val double = now - lastTapAt <= DOUBLE_TAP_MS && within
                    lastTapAt = now
                    lastTapX = x
                    lastTapY = y
                    if (double) onDoubleTap() else onSingleTap()
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    handler.removeCallbacksAndLp()
                    true
                }
                else -> false
            }
        }
        runCatching { wm.addView(ball, params) }
        ballView = ball
    }

    private fun Handler.removeCallbacksAndLp() {
        longPressRunnable?.let { removeCallbacks(it) }
        longPressRunnable = null
    }

    /** 单击：打开/收起悬浮聊天小窗。 */
    private fun onSingleTap() {
        FloatingChatWindowService.toggle(this)
    }

    /** 双击 → 无障碍读屏文字，塞进悬浮对话窗发给角色。 */
    private fun onDoubleTap() {
        val svc = RealityBridgeAccessibility.current()
        if (svc == null) {
            Toast.makeText(this, "读取屏幕文字需要无障碍权限，请在 设置→无障碍 中开启", Toast.LENGTH_LONG).show()
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            return
        }
        val text = runCatching { extractScreenText(svc.dumpScreenTree()) }.getOrDefault("")
        if (text.isBlank()) {
            Toast.makeText(this, "没有读到屏幕上的文字", Toast.LENGTH_SHORT).show()
            return
        }
        FloatingChatWindowService.show(this)
        handler.postDelayed({ FloatingChatWindowService.injectScreenText(this, text) }, 800L)
    }

    /** 从 dumpScreenTree 的节点 JSON 里抽取可见文字/描述，去重后拼接成上下文。 */
    private fun extractScreenText(json: String): String {
        return runCatching {
            val arr = org.json.JSONArray(json)
            val seen = LinkedHashSet<String>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                o.optString("text")?.takeIf { it.isNotBlank() }?.let { seen.add(it.trim()) }
                o.optString("desc")?.takeIf { it.isNotBlank() }?.let { seen.add(it.trim()) }
            }
            seen.joinToString("\n").take(1500)
        }.getOrDefault("")
    }

    /** 刷新球上两个头像：主圆 = 角色头像，角标 = 用户头像；都取不到时退默认图标。 */
    private fun applyBallAvatar() {
        val main = mainAvatarView ?: return
        val bmp = MascotAvatar.bitmap
        if (bmp != null) main.setImageBitmap(bmp) else main.setImageResource(R.drawable.ic_stat)
        val badge = badgeView
        val ubmp = MascotAvatar.userBitmap
        if (badge != null) {
            if (ubmp != null) badge.setImageBitmap(ubmp) else badge.setImageResource(android.R.drawable.ic_menu_myplaces)
        }
    }

    /** 长按：震动反馈并打开小窗直接开始语音听写，识别结果自动填进输入框。 */
    private fun onLongPress() {
        vibrate()
        FloatingChatWindowService.startVoiceDictation(this)
    }

    private fun vibrate() {
        val vib = getSystemService(VIBRATOR_SERVICE) as? android.os.Vibrator ?: return
        runCatching {
            vib.vibrate(
                android.os.VibrationEffect.createOneShot(30, android.os.VibrationEffect.DEFAULT_AMPLITUDE),
            )
        }
    }

    /** 拖动松手后吸附到最近的左/右屏幕边缘。 */
    private fun snapToEdge() {
        val wm = windowManager ?: return
        val v = ballView ?: return
        val params = ballParams ?: return
        val scrW = resources.displayMetrics.widthPixels
        val targetX = if (params.x + ballPx / 2 < scrW / 2) 0 else scrW - ballPx
        params.x = targetX
        runCatching { wm.updateViewLayout(v, params) }
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
            .setContentText("单击聊天，双击读屏，长按语音")
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
        handler.removeCallbacksAndLp()
        ballAvatarObserver?.let { MascotAvatar.removeObserver(it) }
        ballAvatarObserver = null
        runCatching { ballView?.let { windowManager?.removeView(it) } }
        ballView = null
        ballParams = null
        badgeView = null
        mainAvatarView = null
        super.onDestroy()
    }
}
