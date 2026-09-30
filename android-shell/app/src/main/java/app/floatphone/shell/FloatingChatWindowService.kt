package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationCompat

/**
 * 悬浮聊天小窗服务（对齐 Operit 悬浮小窗）。
 *
 * WindowManager 加一个 TYPE_APPLICATION_OVERLAY 小窗（约 320dp × 420dp），
 * 内容是一个 WebView，加载 BuildConfig.SITE_URL + "/chat-float"：
 *  - 与主 WebView 同一进程，CookieManager 单例共享登录态/聊天记录；
 *  - 标题栏可拖动整窗；右侧 ← 返回 / 🎤 语音转文字 / ✕ 关闭；
 *  - 语音识别结果走 MainActivity.deliverSpeechToWeb 回传主网页。
 *
 * 球单击切换显隐；小窗打开时球仍保留在屏幕边缘。
 */
class FloatingChatWindowService : Service() {

    companion object {
        private const val CH_CHAT = "shell_chat"
        private const val NOTIF_FG_ID = 9

        @Volatile
        private var instance: FloatingChatWindowService? = null

        /** 打开小窗（幂等：已在显示则不动）。网页 openFloatingChat 与唤醒词命中走这里。 */
        fun show(context: Context) {
            instance?.ensureShown() ?: run {
                val i = Intent(context, FloatingChatWindowService::class.java)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i)
                else context.startService(i)
            }
        }

        /** 切换显隐：显示中则关闭，否则打开。球单击走这里。 */
        fun toggle(context: Context) {
            val inst = instance
            if (inst != null && inst.isShowing()) inst.closeSelf() else show(context)
        }
    }

    private var windowManager: WindowManager? = null
    private var rootView: View? = null
    private var chatWeb: WebView? = null
    private var recording = false

    /** 最近一次缩放结束后的窗口宽高（px），仅内存记录，不持久化；0 表示未缩放过，用默认尺寸。 */
    private var lastW = 0
    private var lastH = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        startForeground(NOTIF_FG_ID, buildNotification())
        if (!Settings.canDrawOverlays(this)) {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            stopSelf()
            return
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureShown()
        return START_NOT_STICKY
    }

    private fun dp(v: Float): Int = (v * resources.displayMetrics.density).toInt()

    fun isShowing(): Boolean = rootView != null

    private fun ensureShown() {
        if (rootView != null) return
        val wm = getSystemService(WINDOW_SERVICE) as? WindowManager ?: return
        windowManager = wm

        val density = resources.displayMetrics.density
        val w = if (lastW > 0) lastW else (320 * density).toInt()
        val h = if (lastH > 0) lastH else (420 * density).toInt()

        // 根用 FrameLayout：内容（标题栏+WebView）占满，右下角叠一个缩放把手
        val root = FrameLayout(this).apply {
            elevation = dp(8f).toFloat()
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xF0101418.toInt())
        }

        // ── 标题栏：左侧球图标+标题，右侧 ← / 🎤 / ✕
        val titleBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xFF1A1F26.toInt())
            setPadding(dp(10f), dp(8f), dp(6f), dp(8f))
        }
        val title = TextView(this).apply {
            text = "◉ 角色"
            setTextColor(Color.WHITE)
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val backBtn = titleButton("←") {
            val wv = chatWeb
            if (wv != null && wv.canGoBack()) wv.goBack()
            else closeSelf()
        }
        val micBtn = titleButton("🎤") { toggleMic() }
        val closeBtn = titleButton("✕") { closeSelf() }
        titleBar.addView(title)
        titleBar.addView(backBtn)
        titleBar.addView(micBtn)
        titleBar.addView(closeBtn)

        // ── WebView：加载独立聊天页
        CookieManager.getInstance().setAcceptCookie(true)
        val web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString FloatShell/${BuildConfig.VERSION_NAME}"
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                // 站内链接留在小窗 WebView 内；外链交给系统
                val url = request.url
                if (url.host == android.net.Uri.parse(BuildConfig.SITE_URL).host) return false
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
                }.getOrDefault(true)
            }
        }
        web.loadUrl(BuildConfig.SITE_URL.trimEnd('/') + "/chat-float")

        content.addView(titleBar, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        content.addView(web, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(content, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        // ── 右下角缩放把手：48dp 触控热区，视觉是一个小三角 ◢
        val minW = dp(260f)
        val minH = dp(360f)
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val resizeHandle = TextView(this).apply {
            text = "◢"
            setTextColor(0x66FFFFFF)
            textSize = 18f
            gravity = Gravity.BOTTOM or Gravity.END
            setPadding(dp(4f), 0, dp(8f), dp(6f))
        }
        root.addView(resizeHandle, FrameLayout.LayoutParams(
            dp(48f), dp(48f), Gravity.BOTTOM or Gravity.END))

        val params = WindowManager.LayoutParams(
            w, h,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // 不设 NOT_FOCUSABLE：小窗内输入框要弹键盘；NOT_TOUCH_MODAL 让窗外触摸穿透到下面的 App
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = resources.displayMetrics.widthPixels - w - dp(12f)
            y = dp(110f)
        }

        // 标题栏拖动整窗
        var downRawX = 0f
        var downRawY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        titleBar.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = e.rawX
                    downRawY = e.rawY
                    startX = params.x
                    startY = params.y
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downRawX
                    val dy = e.rawY - downRawY
                    if (kotlin.math.hypot(dx, dy) > 10f) moved = true
                    if (moved) {
                        params.x = startX + dx.toInt()
                        params.y = startY + dy.toInt()
                        runCatching { wm.updateViewLayout(root, params) }
                    }
                    true
                }
                MotionEvent.ACTION_UP -> moved
                else -> false
            }
        }

        // 右下角把手缩放：拖动右下角改变宽高，左上角不动；上下限内 clamp，不越出屏幕。
        var resizeDownRawX = 0f
        var resizeDownRawY = 0f
        var resizeStartW = 0
        var resizeStartH = 0
        var resizing = false
        val resizeSlop = dp(3f).toFloat()
        resizeHandle.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    resizeDownRawX = e.rawX
                    resizeDownRawY = e.rawY
                    resizeStartW = params.width
                    resizeStartH = params.height
                    resizing = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - resizeDownRawX
                    val dy = e.rawY - resizeDownRawY
                    if (!resizing && kotlin.math.hypot(dx, dy) < resizeSlop) return@setOnTouchListener true
                    resizing = true
                    val maxW = (screenW - params.x - dp(8f)).coerceAtLeast(minW)
                    val maxH = (screenH - params.y - dp(24f)).coerceAtLeast(minH)
                    params.width = (resizeStartW + dx.toInt()).coerceIn(minW, maxW)
                    params.height = (resizeStartH + dy.toInt()).coerceIn(minH, maxH)
                    runCatching { wm.updateViewLayout(root, params) }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (resizing) {
                        lastW = params.width
                        lastH = params.height
                    }
                    resizing
                }
                else -> false
            }
        }

        // 物理返回键：先 WebView 后退，再关窗（窗口可聚焦时按键才会送达这里）
        root.isFocusableInTouchMode = true
        root.setOnKeyListener { _, keyCode, e ->
            if (keyCode == KeyEvent.KEYCODE_BACK && e.action == KeyEvent.ACTION_UP) {
                val wv = chatWeb
                if (wv != null && wv.canGoBack()) wv.goBack() else closeSelf()
                true
            } else false
        }

        runCatching { wm.addView(root, params) }.onFailure { stopSelf(); return }
        rootView = root
        chatWeb = web
    }

    private fun titleButton(text: String, onClick: () -> Unit): TextView = TextView(this).apply {
        this.text = text
        setTextColor(Color.WHITE)
        textSize = 16f
        gravity = Gravity.CENTER
        setPadding(dp(12f), dp(2f), dp(12f), dp(2f))
        setOnClickListener { onClick() }
    }

    /** 🎤：点一下开始录音识别，再点一下结束；结果回传主网页。 */
    private fun toggleMic() {
        if (!recording) {
            val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                this, android.Manifest.permission.RECORD_AUDIO,
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) {
                Toast.makeText(this, "缺少麦克风权限，请在系统设置中授权", Toast.LENGTH_SHORT).show()
                return
            }
            recording = true
            ShellStt.start(this, "{}") { json ->
                recording = false
                MainActivity.deliverSpeechToWeb(json)
            }
        } else {
            recording = false
            ShellStt.stop()
        }
    }

    /** ✕：移除小窗并停掉本服务。 */
    fun closeSelf() {
        runCatching { rootView?.let { windowManager?.removeView(it) } }
        chatWeb?.destroy()
        chatWeb = null
        rootView = null
        recording = false
        stopSelf()
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CH_CHAT, "悬浮对话窗", NotificationManager.IMPORTANCE_MIN).apply {
                description = "悬浮聊天小窗常驻通知"
                setShowBadge(false)
            },
        )
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CH_CHAT)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("悬浮对话窗已打开")
            .setContentText("点击悬浮球可收起对话窗")
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
        runCatching { rootView?.let { windowManager?.removeView(it) } }
        chatWeb?.destroy()
        chatWeb = null
        rootView = null
        if (instance === this) instance = null
        super.onDestroy()
    }
}
