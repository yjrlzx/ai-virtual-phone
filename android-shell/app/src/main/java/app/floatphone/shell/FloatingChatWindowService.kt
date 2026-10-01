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
import android.graphics.drawable.GradientDrawable
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
import android.widget.ImageView
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

        @Volatile
        private var pendingVoice = false

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

        /** 无障碍抓屏得到的文字，塞进悬浮对话窗发给角色。 */
        fun injectScreenText(context: Context, text: String) {
            instance?.injectScreenText(text)
        }

        /** 长按悬浮球：打开小窗并直接开始语音听写，识别结果填进输入框。 */
        fun startVoiceDictation(context: Context) {
            pendingVoice = true
            show(context)
            instance?.let { inst ->
                inst.mainHandler.postDelayed({
                    pendingVoice = false
                    inst.beginMic()
                }, 700L)
            }
        }
    }

    private var windowManager: WindowManager? = null
    private var rootView: View? = null
    private var chatWeb: WebView? = null
    private var nameView: TextView? = null
    private var avatarObserver: (() -> Unit)? = null
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
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
        if (pendingVoice) {
            pendingVoice = false
            mainHandler.postDelayed({ beginMic() }, 500L)
        }
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

        // ── 标题栏：左侧角色头像+标题，右侧 ← / 🎤 / ✕
        val titleBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xFF1A1F26.toInt())
            setPadding(dp(10f), dp(8f), dp(6f), dp(8f))
        }
        val avatarView = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFF2A3138.toInt())
                setStroke(dp(1f), 0x66FFFFFF.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(dp(28f), dp(28f)).apply {
                rightMargin = dp(8f)
            }
        }
        applyAvatar(avatarView)
        val observer: () -> Unit = { applyAvatar(avatarView) }
        avatarObserver = observer
        MascotAvatar.addObserver(observer)
        val name = TextView(this).apply {
            text = "角色"
            setTextColor(Color.WHITE)
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        nameView = name
        val backBtn = titleButton("←") {
            val wv = chatWeb
            if (wv != null && wv.canGoBack()) wv.goBack()
            else closeSelf()
        }
        val micBtn = titleButton("🎤") { toggleMic() }
        val closeBtn = titleButton("✕") { closeSelf() }
        titleBar.addView(avatarView)
        titleBar.addView(name)
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
        // 网页上报角色头像/名字；双击悬浮球读到的屏幕文字经 window.FloatShellOnScreenText 回传
        web.addJavascriptInterface(FloatBridge(), "FloatShell")
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
            // 悬浮窗默认不随键盘 resize：软键盘弹起时 WebView 要压缩高度，
            // 否则页面底部输入框会被键盘顶出可视区（用户看不到输入框）
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
                WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN
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

    /** 🎤：点一下开始录音识别，再点一下结束；结果填进本窗输入框。 */
    private fun toggleMic() {
        if (recording) stopMic() else beginMic()
    }

    /** 开始听写（长按悬浮球与标题栏 🎤 共用）。 */
    fun beginMic() {
        if (recording) return
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
            this, android.Manifest.permission.RECORD_AUDIO,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) {
            Toast.makeText(this, "缺少麦克风权限，请在系统设置中授权", Toast.LENGTH_SHORT).show()
            return
        }
        recording = true
        Toast.makeText(this, "正在听，请说话…", Toast.LENGTH_SHORT).show()
        ShellStt.start(this, "{}") { json ->
            recording = false
            val text = runCatching { org.json.JSONObject(json).optString("text") }.getOrDefault("")
            if (text.isNotBlank()) fillInput(text)
        }
    }

    private fun stopMic() {
        recording = false
        ShellStt.stop()
    }

    /** 把文字填进 chat-float 页底部输入框（走 React 受控 input 的原生 setter 才会触发状态更新）。 */
    private fun fillInput(text: String) {
        val js = """
            (function(){
              try {
                var ta = document.querySelector('.chat-input-textarea');
                if (!ta) return;
                var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(ta, ta.value + ${org.json.JSONObject.quote(text)});
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.focus();
              } catch (e) {}
            })();
        """.trimIndent()
        chatWeb?.evaluateJavascript(js, null)
    }

    /** 双击悬浮球读到的屏幕文字：注入 chat-float 页作为上下文发送。 */
    fun injectScreenText(text: String) {
        chatWeb?.evaluateJavascript(
            "window.FloatShellOnScreenText && window.FloatShellOnScreenText(${org.json.JSONObject.quote(text)})",
            null,
        )
    }

    /** 标题栏头像：MascotAvatar 有缓存圆图就用，否则显示深色占位圆。 */
    private fun applyAvatar(target: ImageView) {
        val bmp = MascotAvatar.bitmap
        if (bmp != null) {
            target.setImageBitmap(bmp)
        } else {
            target.setImageDrawable(null)
        }
    }

    /** chat-float 页 → 壳侧桥：上报角色头像与名字。 */
    private inner class FloatBridge {
        @android.webkit.JavascriptInterface
        fun setAvatar(url: String) {
            MascotAvatar.set(this@FloatingChatWindowService, url)
        }

        @android.webkit.JavascriptInterface
        fun setUserAvatar(url: String) {
            MascotAvatar.setUser(this@FloatingChatWindowService, url)
        }

        @android.webkit.JavascriptInterface
        fun setTitle(name: String) {
            val clean = name.trim().take(16)
            if (clean.isBlank()) return
            mainHandler.post { nameView?.text = clean }
        }

        /** 打开其他应用：与 MainActivity 的 openApp 同实现，悬浮窗里的 char 也能调。 */
        @android.webkit.JavascriptInterface
        fun openApp(packageName: String): String {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
                ?: return """{"ok":false,"error":"未找到应用 $packageName"}"""
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            mainHandler.post { runCatching { startActivity(intent) } }
            return """{"ok":true}"""
        }

        /** 点击屏幕坐标（归一化 0..1000）：悬浮窗里的 char 也能操控手机。 */
        @android.webkit.JavascriptInterface
        fun tap(x: Int, y: Int): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.tapCoordinate(x, y)
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 返回键：goBack 是 pressKey("back") 的便捷别名。 */
        @android.webkit.JavascriptInterface
        fun goBack(): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.pressKey("back")
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 滑动屏幕（归一化 0..1000 起终点）。 */
        @android.webkit.JavascriptInterface
        fun swipe(x1: Int, y1: Int, x2: Int, y2: Int): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.swipeCoordinate(x1, y1, x2, y2)
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 在当前聚焦输入框写入文字。 */
        @android.webkit.JavascriptInterface
        fun inputText(text: String): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.inputText(text)
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 回桌面。 */
        @android.webkit.JavascriptInterface
        fun goHome(): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.pressKey("home")
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 锁屏。 */
        @android.webkit.JavascriptInterface
        fun lockScreen(): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.pressKey("lock_screen")
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 下拉通知栏。 */
        @android.webkit.JavascriptInterface
        fun openNotificationShade(): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.pressKey("notifications")
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 读屏幕节点树。 */
        @android.webkit.JavascriptInterface
        fun readScreenTree(limit: Int): String =
            RealityBridgeAccessibility.current()?.dumpScreenTree(limit)
                ?: """{"ok":false,"error":"无障碍服务未开启"}"""

        /** 按文字点节点。 */
        @android.webkit.JavascriptInterface
        fun clickNodeByText(text: String): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.clickNodeByText(text)
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 按描述点节点。 */
        @android.webkit.JavascriptInterface
        fun clickNodeByDescription(desc: String): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.clickNodeByDescription(desc)
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 向前滚动。 */
        @android.webkit.JavascriptInterface
        fun scrollForward(): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.scrollForward()
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 对当前聚焦输入框写文字。 */
        @android.webkit.JavascriptInterface
        fun setTextOnFocusedField(text: String): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.setTextOnFocusedField(text)
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject(r).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 门禁列表代理：悬浮窗里的锁定/解锁工具直接走无障碍服务同一份配置。 */
        @android.webkit.JavascriptInterface
        fun setLockedPackages(json: String): String = runCatching {            val arr = org.json.JSONArray(json)
            val pkgs = ArrayList<String>()
            for (i in 0 until arr.length()) pkgs.add(arr.getString(i))
            RealityBridgeAccessibility.setLockedPackages(this@FloatingChatWindowService, pkgs)
            org.json.JSONObject()
                .put("ok", true)
                .put("locked", RealityBridgeAccessibility.getLockedPackages().size)
                .toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        @android.webkit.JavascriptInterface
        fun getLockedPackages(): String =
            org.json.JSONArray(RealityBridgeAccessibility.getLockedPackages()).toString()

        /** 单包锁定：minutes<=0 永久，上限 1440 分钟；message 为 char 留言。 */
        @android.webkit.JavascriptInterface
        fun lockPackage(packageName: String, minutes: Int, message: String): String = runCatching {
            RealityBridgeAccessibility.lockPackage(this@FloatingChatWindowService, packageName.trim(), minutes, message)
            org.json.JSONObject().put("ok", true).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        @android.webkit.JavascriptInterface
        fun unlockPackage(packageName: String): String = runCatching {
            RealityBridgeAccessibility.unlockPackage(this@FloatingChatWindowService, packageName.trim())
            org.json.JSONObject().put("ok", true).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 今日应用使用时长 TOP20（需用量访问权限）。 */
        @android.webkit.JavascriptInterface
        fun getAppUsageTime(): String = runCatching {            val usm = getSystemService(USAGE_STATS_SERVICE) as android.app.usage.UsageStatsManager
            val cal = java.util.Calendar.getInstance()
            cal.set(java.util.Calendar.HOUR_OF_DAY, 0)
            cal.set(java.util.Calendar.MINUTE, 0)
            cal.set(java.util.Calendar.SECOND, 0)
            cal.set(java.util.Calendar.MILLISECOND, 0)
            val stats = usm.queryUsageStats(
                android.app.usage.UsageStatsManager.INTERVAL_BEST,
                cal.timeInMillis,
                System.currentTimeMillis(),
            )
            val agg = HashMap<String, Long>()
            stats?.forEach { agg[it.packageName] = (agg[it.packageName] ?: 0L) + it.totalTimeInForeground }
            val arr = org.json.JSONArray()
            agg.entries.sortedByDescending { it.value }.take(20).forEach { (pkg, ms) ->
                arr.put(org.json.JSONObject().put("pkg", pkg).put("totalTimeMs", ms))
            }
            org.json.JSONObject().put("ok", true).put("usages", arr).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }

        /** 唤醒屏幕（亮屏）。 */
        @android.webkit.JavascriptInterface
        fun wakeUp(): String = runCatching {
            val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
            @Suppress("DEPRECATION")
            pm.newWakeLock(
                android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "floatshell:wake",
            ).acquire(10_000L)
            org.json.JSONObject().put("ok", true).toString()
        }.getOrElse { """{"ok":false,"error":"$it"}""" }
    }

    /** ✕：移除小窗并停掉本服务。 */
    fun closeSelf() {
        runCatching { rootView?.let { windowManager?.removeView(it) } }
        chatWeb?.destroy()
        chatWeb = null
        rootView = null
        nameView = null
        avatarObserver?.let { MascotAvatar.removeObserver(it) }
        avatarObserver = null
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
