package app.floatphone.shell

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.media.AudioManager
import android.net.Uri
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

/**
 * Float 小手机安卓壳：全屏 WebView 直接加载线上站点。
 * 网页每次部署即时生效，本壳只负责原生能力（推送长连接、文件上下行、外链）。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        val SITE_URL: String = BuildConfig.SITE_URL
        const val VERSION = "1.0.0"
        /** 来电接听等场景的站内深链（必须以 SITE_URL 开头，否则忽略） */
        const val EXTRA_OPEN_URL = "open_url"
        /** 请求截屏授权（悬浮球双击时由原生或网页触发） */
        const val ACTION_REQUEST_SCREEN_CAPTURE = "app.floatphone.shell.REQUEST_SCREEN_CAPTURE"
        /** 截图结果交给网页速聊 */
        const val ACTION_SCREEN_SHOT_DELIVERED = "app.floatphone.shell.SCREEN_SHOT_DELIVERED"
        /** 主动提醒的本地通知渠道（与 PushService 的「角色消息」同渠道，复用其可见性设置） */
        const val CH_SHELL_MESSAGES = "shell_messages"

        /** 当前存活的活动实例：悬浮球等后台服务借它回调网页速聊。 */
        @Volatile
        private var activeActivity: MainActivity? = null

        /** 悬浮球截完屏后调用：把位图交给活动实例回传给网页。 */
        fun deliverScreenShotToWeb(bitmap: android.graphics.Bitmap?) {
            activeActivity?.deliverToWeb(bitmap)
        }

        /** 悬浮球双击发现需要重新截屏授权时调用：借活动实例切回主线程弹系统授权。
         *  授权成功后 screenCaptureLauncher 回调会自动 deliverLatestScreenShot() 再截一次并回传网页。 */
        fun requestScreenCaptureForFloatingBall() {
            val act = activeActivity ?: return
            act.runOnUiThread { act.requestScreenCapture() }
        }

        /** 语音识别结果回传网页（ShellStt 回调线程 → 主线程 evaluateJavascript，JSON 经 base64 防转义问题）。 */
        fun deliverSpeechToWeb(json: String) {
            val act = activeActivity ?: return
            val b64 = android.util.Base64.encodeToString(json.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
            act.runOnUiThread {
                act.webView.evaluateJavascript("window.__floatBridgeOnSpeechText && window.__floatBridgeOnSpeechText(new TextDecoder('utf-8').decode(Uint8Array.from(atob('$b64'), function(c){return c.charCodeAt(0)})))", null)
            }
        }

        /** 唤醒词命中回传网页（WakeWordService → window.__floatBridgeOnWakeWord）。 */
        fun deliverWakeWordToWeb(json: String) {
            val act = activeActivity ?: return
            val b64 = android.util.Base64.encodeToString(json.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
            act.runOnUiThread {
                act.webView.evaluateJavascript("window.__floatBridgeOnWakeWord && window.__floatBridgeOnWakeWord(new TextDecoder('utf-8').decode(Uint8Array.from(atob('$b64'), function(c){return c.charCodeAt(0)})))", null)
            }
        }

        /** OCR 识别结果回传网页（ShellOcr → window.__floatBridgeOnOcrResult）。 */
        fun deliverOcrToWeb(json: String) {
            val act = activeActivity ?: return
            val b64 = android.util.Base64.encodeToString(json.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
            act.runOnUiThread {
                act.webView.evaluateJavascript("window.__floatBridgeOnOcrResult && window.__floatBridgeOnOcrResult(new TextDecoder('utf-8').decode(Uint8Array.from(atob('$b64'), function(c){return c.charCodeAt(0)})))", null)
            }
        }
    }

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    /** sendNotification 的本地通知 id 自增序列（避开前台/来电等固定 id） */
    private var shellNotifSeq = 200

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val data = result.data?.data
        callback.onReceiveValue(if (data != null) arrayOf(data) else emptyArray())
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) PushService.start(this)
    }

    /** 现实桥截屏授权：悬浮球双击或网页请求截图时弹出系统授权 */
    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        MediaProjectionCapture.projectionToken = result.data
        if (result.resultCode == RESULT_OK) {
            // 授权后立即截一次，交给网页速聊
            deliverLatestScreenShot()
        }
    }

    /** 现实桥位置授权：getLocation 首次调用时触发系统授权 */
    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* 授权结果由下一次 getLocation 重新读取 */ }

    // 网页侧 getUserMedia（通话按住说话、语音条录音、视频通话摄像头）触发的
    // WebView 权限请求：先要系统运行时权限，拿到后再转授给页面。
    // 不实现 onPermissionRequest 时 WebView 会静默拒绝，页面永远拿不到麦克风。
    private var pendingWebPermissionRequest: android.webkit.PermissionRequest? = null

    private val webPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingWebPermissionRequest ?: return@registerForActivityResult
        pendingWebPermissionRequest = null
        val granted = request.resources.filter { resource ->
            webResourcePermissions(resource).all {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
        }
        if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
    }

    private fun webResourcePermissions(resource: String): List<String> = when (resource) {
        android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        else -> emptyList()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Companion.activeActivity = this
        WindowCompat.setDecorFitsSystemWindows(window, true)
        // 音量键默认调媒体流：WebView 里的语音条/TTS 都走媒体流播放，
        // 不设的话短音频没在播时按键调的是铃声，用户感觉"音量键无效、声音巨大"
        volumeControlStream = AudioManager.STREAM_MUSIC

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            userAgentString = "$userAgentString FloatShell/$VERSION"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(ShellBridge(), "AndroidShell")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return false
                // 站内导航留在壳里；http(s) 外链和自定义协议（shortcuts:// 等）交给系统
                if (scheme == "http" || scheme == "https") {
                    if (url.host == Uri.parse(SITE_URL).host) return false
                    return runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url)); true
                    }.getOrDefault(true)
                }
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                }.getOrDefault(true)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                val supported = request.resources.filter { webResourcePermissions(it).isNotEmpty() }
                if (supported.isEmpty()) { request.deny(); return }
                val missing = supported.flatMap { webResourcePermissions(it) }
                    .distinct()
                    .filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) { request.grant(supported.toTypedArray()); return }
                if (pendingWebPermissionRequest != null) { request.deny(); return }
                pendingWebPermissionRequest = request
                webPermissionLauncher.launch(missing.toTypedArray())
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(emptyArray())
                filePathCallback = callback
                return runCatching {
                    fileChooserLauncher.launch(params.createIntent()); true
                }.getOrElse {
                    filePathCallback = null; false
                }
            }
        }

        // 备份导出等下载：交给系统下载管理器，落到公共下载目录
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            runCatching {
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // blob/data 由页面内 JS 触发的 a[download] 处理；提示用户等待
                    Toast.makeText(this, "正在导出…", Toast.LENGTH_SHORT).show()
                    return@DownloadListener
                }
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("User-Agent", userAgent)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType),
                    )
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "已开始下载到「下载」目录", Toast.LENGTH_SHORT).show()
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
        })

        // 冷启动带深链（如来电接听）直接加载目标；否则加载首页
        webView.loadUrl(consumeOpenUrl(intent) ?: SITE_URL)
        ensurePushService()
    }

    /** singleTask：App 已在运行时（如全屏来电页接听）通过 onNewIntent 送达深链 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        when (intent.action) {
            ACTION_REQUEST_SCREEN_CAPTURE -> { requestScreenCapture(); return }
            else -> { /* fallthrough */ }
        }
        val target = consumeOpenUrl(intent) ?: return
        // SPA 已加载：loadUrl 到同页 hash 只触发 hashchange，不会整页重载
        webView.loadUrl(target)
    }

    /** 弹出系统截屏授权；结果回 screenCaptureLauncher。 */
    private fun requestScreenCapture() {
        val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager ?: return
        // ActivityResultLauncher.launch 必须在主线程；captureScreen() 桥运行在 WebView JavaBridge 线程
        runOnUiThread { runCatching { screenCaptureLauncher.launch(mpm.createScreenCaptureIntent()) } }
    }

    /** 授权后立即截一次屏，交给网页速聊（悬浮球双击也会走到这里）。 */
    private fun deliverLatestScreenShot() {
        MediaProjectionCapture.capture(this) { bitmap -> deliverToWeb(bitmap) }
    }

    /** 把截图位图回传给网页（window.__floatBridgeOnScreenShot）。 */
    private fun deliverToWeb(bitmap: android.graphics.Bitmap?) {
        if (bitmap == null) {
            runCatching {
                webView.evaluateJavascript(
                    "window.__floatBridgeOnScreenShot && window.__floatBridgeOnScreenShot(null)",
                    null,
                )
            }
            return
        }
        runCatching {
            val out = java.io.ByteArrayOutputStream()
            bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out)
            val b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
            webView.evaluateJavascript(
                "window.__floatBridgeOnScreenShot && window.__floatBridgeOnScreenShot('data:image/jpeg;base64,$b64')",
                null,
            )
        }
    }

    private fun consumeOpenUrl(intent: Intent?): String? {
        val target = intent?.getStringExtra(EXTRA_OPEN_URL) ?: return null
        intent.removeExtra(EXTRA_OPEN_URL)
        return target.takeIf { it.startsWith(SITE_URL) }
    }

    private fun ensurePushService() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            PushService.start(this)
        }
    }

    override fun onDestroy() {
        if (Companion.activeActivity === this) Companion.activeActivity = null
        CookieManager.getInstance().flush()
        webView.destroy()
        super.onDestroy()
    }

    /** 暴露给网页的原生桥（网页侧可用 window.AndroidShell 特性检测壳环境）。 */
    inner class ShellBridge {
        @JavascriptInterface
        fun getVersion(): String = VERSION

        /** 构造安全的错误 JSON：用 JSONObject.quote 转义，避免异常 message 里带引号/反斜杠/换行产出非法 JSON。 */
        private fun errJson(e: String?): String =
            """{"ok":false,"error":${org.json.JSONObject.quote(e ?: "未知错误")}}"""

        /** 打开本应用的系统设置页（引导用户关电池限制、开自启动）。 */
        @JavascriptInterface
        fun openAppSettings() {
            runOnUiThread {
                runCatching {
                    startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
            }
        }

        /** 请求忽略电池优化（保活关键一步）。 */
        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestIgnoreBatteryOptimization() {
            runOnUiThread {
                runCatching {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
            }
        }

        // ── 现实桥·华为端原生能力（网页经 window.AndroidShell 调用） ──

        @JavascriptInterface
        fun accessibilityActive(): Boolean = RealityBridgeAccessibility.active()

        @JavascriptInterface
        fun dumpScreen(): String =
            RealityBridgeAccessibility.current()?.dumpScreenTree()
                ?: """{"ok":false,"error":"无障碍服务未开启"}"""

        @JavascriptInterface
        fun clickText(text: String): String =
            try {
                val r = RealityBridgeAccessibility.current()?.clickText(text)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        @JavascriptInterface
        fun inputText(text: String): String =
            try {
                val r = RealityBridgeAccessibility.current()?.inputText(text)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 网页请求截屏（触发系统授权 + 回传速聊）。 */
        @JavascriptInterface
        fun captureScreen() {
            runCatching { requestScreenCapture() }
        }

        /** 打开其他应用（open_app 的华为端实现）。 */
        @JavascriptInterface
        fun openApp(packageName: String): String {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
                ?: return errJson("未找到应用 $packageName")
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // startActivity 切回主线程执行（本桥方法运行在 WebView 的 JavaBridge 线程）
            runOnUiThread { runCatching { startActivity(intent) } }
            return """{"ok":true}"""
        }

        /** 状态快照：电量、音量、是否连网、无障碍/悬浮球状态。 */
        @JavascriptInterface
        fun getStatus(): String = runCatching {
            val bm = getSystemService(BATTERY_SERVICE) as android.os.BatteryManager
            val level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val am = getSystemService(AUDIO_SERVICE) as android.media.AudioManager
            val volume = am.getStreamVolume(android.media.AudioManager.STREAM_MUSIC)
            val cm = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val net = cm.activeNetwork != null
            org.json.JSONObject()
                .put("ok", true)
                .put("battery", level)
                .put("volume", volume)
                .put("network", net)
                .put("accessibility", RealityBridgeAccessibility.active())
                .put("floating", RealityBridgeFloatingService.canDrawOverlays(this@MainActivity))
                .put("lockedApps", RealityBridgeAccessibility.getLockedPackages().size)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 开关悬浮球（悬浮球双击速聊）。 */
        @JavascriptInterface
        fun setFloating(enabled: Boolean) {
            if (enabled) {
                RealityBridgeFloatingService.start(this@MainActivity)
            } else {
                runCatching {
                    stopService(Intent(this@MainActivity, RealityBridgeFloatingService::class.java))
                }
            }
        }

        /** 设置应用门禁锁定包名列表（入参为 JSON 数组字符串）。 */
        @JavascriptInterface
        fun setLockedPackages(json: String): String = runCatching {
            val arr = org.json.JSONArray(json)
            val pkgs = ArrayList<String>()
            for (i in 0 until arr.length()) pkgs.add(arr.getString(i))
            RealityBridgeAccessibility.setLockedPackages(pkgs)
            org.json.JSONObject()
                .put("ok", true)
                .put("locked", RealityBridgeAccessibility.getLockedPackages().size)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 获取当前应用门禁锁定包名列表（JSON 数组）。 */
        @JavascriptInterface
        fun getLockedPackages(): String =
            org.json.JSONArray(RealityBridgeAccessibility.getLockedPackages()).toString()

        /** 无障碍长按（归一化 0..1000 坐标）。 */
        @JavascriptInterface
        fun longPress(x: Int, y: Int): String =
            try {
                val r = RealityBridgeAccessibility.current()?.longPressCoordinate(x, y)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 无障碍滑动（归一化 0..1000 起终点）。 */
        @JavascriptInterface
        fun swipe(x1: Int, y1: Int, x2: Int, y2: Int): String =
            try {
                val r = RealityBridgeAccessibility.current()?.swipeCoordinate(x1, y1, x2, y2)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 系统按键：home / back / recents / lock_screen。 */
        @JavascriptInterface
        fun pressKey(key: String): String =
            try {
                val r = RealityBridgeAccessibility.current()?.pressKey(key)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 通知快照（需通知使用权）：最近 limit 条通知。 */
        @JavascriptInterface
        fun getNotifications(limit: Int): String =
            RealityBridgeNotificationStore.snapshot(limit)

        /** 支付通知解析（自动记账原料）：金额 + 收款方 + 来源 App。 */
        @JavascriptInterface
        fun getPayments(limit: Int): String =
            RealityBridgeNotificationStore.payments(limit)

        /** 当前前台应用包名（此刻状态·当前 App）。 */
        @JavascriptInterface
        fun getCurrentApp(): String = runCatching {
            val pkg = RealityBridgeAccessibility.current()?.foregroundApp().orEmpty()
            org.json.JSONObject()
                .put("ok", true)
                .put("currentApp", pkg)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 实时位置（经纬度）：未授权时触发系统授权。 */
        @JavascriptInterface
        fun getLocation(): String {
            val hasFine = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            val hasCoarse = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (!hasFine && !hasCoarse) {
                // 权限请求 launcher 必须切回主线程调用
                runOnUiThread {
                    runCatching {
                        locationPermissionLauncher.launch(arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION,
                        ))
                    }
                }
                return """{"ok":false,"error":"需要位置权限，已弹出授权，请再次获取"}"""
            }
            return runCatching {
                val lm = getSystemService(LOCATION_SERVICE) as android.location.LocationManager
                val loc = lm.getLastKnownLocation(android.location.LocationManager.GPS_PROVIDER)
                    ?: lm.getLastKnownLocation(android.location.LocationManager.NETWORK_PROVIDER)
                if (loc == null) return """{"ok":false,"error":"暂拿不到位置，请开启定位服务"}"""
                org.json.JSONObject()
                    .put("ok", true)
                    .put("lat", loc.latitude)
                    .put("lng", loc.longitude)
                    .toString()
            }.getOrElse { errJson(it.message) }
        }

        /** 专注模式：durationMin 分钟锁全机（除壳自身外一切前台拦截回桌面）。 */
        @JavascriptInterface
        fun focusMode(durationMin: Int): String = runCatching {
            RealityBridgeAccessibility.setFocusMode(durationMin)
            org.json.JSONObject().put("ok", true).put("focusing", RealityBridgeAccessibility.isFocusing()).toString()
        }.getOrElse { errJson(it.message) }

        /** 屏幕休息：seconds 秒后自动息屏。 */
        @JavascriptInterface
        fun screenBreak(seconds: Int): String = runCatching {
            val r = RealityBridgeAccessibility.current()?.screenBreak(seconds)
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            org.json.JSONObject().put("ok", true).toString()
        }.getOrElse { errJson(it.message) }

        /** 网页主动推送本地提醒：标题 + 内容 + 可选点击后打开的应用包名。 */
        @JavascriptInterface
        fun sendNotification(title: String, content: String, openApp: String?): String {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                return """{"ok":false,"error":"未授予通知权限（系统设置 → 通知）"}"""
            }
            return runCatching {
                val manager = getSystemService(NotificationManager::class.java)
                manager.createNotificationChannel(
                    NotificationChannel(CH_SHELL_MESSAGES, "角色消息", NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "角色发来的离线消息"
                    },
                )
                var tapIntent: Intent =
                    Intent(this@MainActivity, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                if (!openApp.isNullOrBlank()) {
                    val launch = packageManager.getLaunchIntentForPackage(openApp.trim())
                    if (launch != null) {
                        tapIntent = launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    }
                }
                val code = shellNotifSeq++
                val pending = PendingIntent.getActivity(
                    this@MainActivity, code, tapIntent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                val notification = androidx.core.app.NotificationCompat.Builder(this@MainActivity, CH_SHELL_MESSAGES)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle(title)
                    .setContentText(content)
                    .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(content))
                    .setAutoCancel(true)
                    .setContentIntent(pending)
                    .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                    .build()
                manager.notify(code, notification)
                """{"ok":true}"""
            }.getOrElse { errJson(it.message) }
        }

        /** 查询是否处于专注模式。 */
        @JavascriptInterface
        fun isFocusing(): Boolean = RealityBridgeAccessibility.isFocusing()

        /** 设备详情：存储总/可用、内存、机型、系统版本、电池温度、运行时长。 */
        @JavascriptInterface
        fun getDeviceInfo(): String = runCatching {
            val stat = android.os.StatFs(Environment.getDataDirectory().absolutePath)
            val am = getSystemService(ACTIVITY_SERVICE) as android.app.ActivityManager
            val mem = android.app.ActivityManager.MemoryInfo()
            am.getMemoryInfo(mem)
            val batteryIntent = this@MainActivity.registerReceiver(
                null,
                android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED),
            )
            val tempTenths = batteryIntent?.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            val batteryTempC: Any? = if (tempTenths == null || tempTenths == Int.MIN_VALUE) null else tempTenths / 10.0
            org.json.JSONObject()
                .put("ok", true)
                .put("storageTotal", stat.totalBytes)
                .put("storageFree", stat.availableBytes)
                .put("ramTotal", mem.totalMem)
                .put("ramFree", mem.availMem)
                .put("model", Build.MODEL)
                .put("brand", Build.BRAND)
                .put("androidVersion", Build.VERSION.RELEASE)
                .put("sdkInt", Build.VERSION.SDK_INT)
                .put("batteryTempC", batteryTempC)
                .put("uptimeMs", android.os.SystemClock.uptimeMillis())
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 调节音量：stream=media/alarm/ring，value 0-100。 */
        @JavascriptInterface
        fun setVolume(stream: String, value: Int): String = runCatching {
            val am = getSystemService(AUDIO_SERVICE) as android.media.AudioManager
            val s = when (stream) {
                "alarm" -> android.media.AudioManager.STREAM_ALARM
                "ring" -> android.media.AudioManager.STREAM_RING
                else -> android.media.AudioManager.STREAM_MUSIC
            }
            val max = am.getStreamMaxVolume(s)
            val target = (value.coerceIn(0, 100) * max / 100)
            am.setStreamVolume(s, target, 0)
            org.json.JSONObject()
                .put("ok", true)
                .put("stream", stream)
                .put("value", value)
                .put("level", target)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 调节屏幕亮度：value 0-100（百分比）自动换算 0-255 写入系统设置。 */
        @JavascriptInterface
        fun setBrightness(value: Int): String = runCatching {
            if (!Settings.System.canWrite(this@MainActivity)) {
                // startActivity 切回主线程（本桥方法运行在 WebView 的 JavaBridge 线程）
                runOnUiThread {
                    runCatching {
                        startActivity(
                            Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:$packageName"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }
                return """{"ok":false,"error":"需要「修改系统设置」权限，已弹出授权页，请允许后重试"}"""
            }
            val level = (value.coerceIn(0, 100) * 255 / 100)
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, level)
            org.json.JSONObject()
                .put("ok", true)
                .put("value", value)
                .put("level", level)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 读取剪贴板文本（Android 13+ 需应用在前台时读取）。 */
        @JavascriptInterface
        fun readClipboard(): String = runCatching {
            val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            if (!cm.hasPrimaryClip()) return """{"ok":true,"text":""}"""
            val clip = cm.primaryClip
            if (clip == null || clip.itemCount == 0) return """{"ok":true,"text":""}"""
            val text = clip.getItemAt(0).coerceToText(this@MainActivity).toString()
            org.json.JSONObject()
                .put("ok", true)
                .put("text", text)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 写入剪贴板文本。 */
        @JavascriptInterface
        fun writeClipboard(text: String): String = runCatching {
            val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            cm.setPrimaryClip(android.content.ClipData.newPlainText("角色剪贴板", text))
            """{"ok":true}"""
        }.getOrElse { errJson(it.message) }

        /** 用系统浏览器打开网页（仅 http/https）。 */
        @JavascriptInterface
        fun openUrl(url: String): String = runCatching {
            val uri = Uri.parse(url.trim())
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return """{"ok":false,"error":"只支持 http/https 链接"}"""
            // startActivity 切回主线程（本桥方法运行在 WebView 的 JavaBridge 线程）
            runOnUiThread {
                runCatching {
                    startActivity(
                        Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
            }
            """{"ok":true}"""
        }.getOrElse { errJson(it.message) }

        /** 读取文件：path 空时定位 Download 目录；目录返回文件列表；文本返回内容；图片返回缩放预览。 */
        @JavascriptInterface
        fun readFile(path: String): String = runCatching {
            val download = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val target = if (path.isBlank()) download else java.io.File(path)
            if (!target.exists()) return """{"ok":false,"error":"文件不存在：$path"}"""
            if (target.isDirectory) {
                val children = target.listFiles()?.take(100)?.map { f ->
                    org.json.JSONObject()
                        .put("name", f.name)
                        .put("size", f.length())
                        .put("isDir", f.isDirectory)
                } ?: emptyList()
                return org.json.JSONObject()
                    .put("ok", true)
                    .put("kind", "dir")
                    .put("path", target.absolutePath)
                    .put("files", org.json.JSONArray(children))
                    .toString()
            }
            if (target.length() > 512L * 1024L) {
                return """{"ok":false,"error":"文件超过 512KB，不适合直接读取（${target.length()} 字节）"}"""
            }
            val bytes = target.readBytes()
            val name = target.name.lowercase()
            val isImage = name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") ||
                name.endsWith(".gif") || name.endsWith(".webp") || name.endsWith(".bmp")
            if (isImage) {
                val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bmp == null) return """{"ok":false,"error":"图片解码失败"}"""
                val maxEdge = 1024
                val scale = if (bmp.width > bmp.height) maxEdge.toFloat() / bmp.width else maxEdge.toFloat() / bmp.height
                val out = if (scale < 1f) {
                    val w = (bmp.width * scale).toInt().coerceAtLeast(1)
                    val h = (bmp.height * scale).toInt().coerceAtLeast(1)
                    android.graphics.Bitmap.createScaledBitmap(bmp, w, h, true)
                } else bmp
                val baos = java.io.ByteArrayOutputStream()
                out.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, baos)
                val b64 = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP)
                return org.json.JSONObject()
                    .put("ok", true)
                    .put("kind", "image")
                    .put("path", target.absolutePath)
                    .put("size", target.length())
                    .put("width", bmp.width)
                    .put("height", bmp.height)
                    .put("mime", "image/jpeg")
                    .put("dataUrl", "data:image/jpeg;base64,$b64")
                    .toString()
            }
            val text = String(bytes, Charsets.UTF_8)
            org.json.JSONObject()
                .put("ok", true)
                .put("kind", "text")
                .put("path", target.absolutePath)
                .put("size", target.length())
                .put("content", text)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 执行一条简单 shell 命令（以应用身份运行，受限命令会返回错误）。 */
        @JavascriptInterface
        fun runShellCommand(command: String): String = runCatching {
            if (command.isBlank()) return """{"ok":false,"error":"命令为空"}"""
            val proc = Runtime.getRuntime().exec(arrayOf("sh", "-c", command.take(4000)))
            val out = proc.inputStream.bufferedReader().readText()
            val err = proc.errorStream.bufferedReader().readText()
            val code = proc.waitFor()
            org.json.JSONObject()
                .put("ok", true)
                .put("exitCode", code)
                .put("output", (out + err).take(60000))
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 开始语音转文字。configJson: {mode:"system"|"online", url, key, model}；识别结果异步回传 window.__floatBridgeOnSpeechText。 */
        @JavascriptInterface
        fun startListening(configJson: String): String {
            ShellStt.start(this@MainActivity, configJson) { json -> deliverSpeechToWeb(json) }
            return """{"ok":true,"started":true}"""
        }

        /** 结束语音转文字（停止识别/录音并出结果）。 */
        @JavascriptInterface
        fun stopListening(): String {
            ShellStt.stop()
            return """{"ok":true}"""
        }

        /** 来电铃声+震动。timeoutSec 秒后自动收场。 */
        @JavascriptInterface
        fun ring(timeoutSec: Int): String {
            val sec = if (timeoutSec in 5..120) timeoutSec else 30
            RingingAlert.start(this@MainActivity, sec * 1000L)
            return """{"ok":true}"""
        }

        /** 停止来电铃声+震动。 */
        @JavascriptInterface
        fun stopRing(): String {
            RingingAlert.stop()
            return """{"ok":true}"""
        }

        /** 开启常驻语音唤醒（前台服务）。configJson: {wakeWord, mode:"system"|"on_device"}；命中回传 window.__floatBridgeOnWakeWord。 */
        @JavascriptInterface
        fun startWakeWord(configJson: String): String {
            val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                this@MainActivity, android.Manifest.permission.RECORD_AUDIO,
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) {
                return """{"ok":false,"error":"缺少麦克风权限，请先在系统设置中授权"}"""
            }
            WakeWordService.start(this@MainActivity, configJson)
            return """{"ok":true,"started":true}"""
        }

        /** 关闭常驻语音唤醒。 */
        @JavascriptInterface
        fun stopWakeWord(): String {
            WakeWordService.stop(this@MainActivity)
            return """{"ok":true}"""
        }

        /** 录制并登记一条唤醒词语音模板（端上唤醒模式使用，最多 3 条）。 */
        @JavascriptInterface
        fun enrollWakeWord(): String = runCatching {
            val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                this@MainActivity, android.Manifest.permission.RECORD_AUDIO,
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) return """{"ok":false,"error":"缺少麦克风权限"}"""
            val sampleRate = 16000
            val seconds = 2
            val minBuf = android.media.AudioRecord.getMinBufferSize(
                sampleRate,
                android.media.AudioFormat.CHANNEL_IN_MONO,
                android.media.AudioFormat.ENCODING_PCM_16BIT,
            )
            val record = android.media.AudioRecord(
                android.media.MediaRecorder.AudioSource.MIC,
                sampleRate,
                android.media.AudioFormat.CHANNEL_IN_MONO,
                android.media.AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2,
            )
            val total = sampleRate * seconds
            val pcm = ShortArray(total)
            record.startRecording()
            var read = 0
            while (read < total) {
                val n = record.read(pcm, read, total - read)
                if (n <= 0) break
                read += n
            }
            runCatching { record.stop() }
            runCatching { record.release() }
            if (read < sampleRate / 2) return """{"ok":false,"error":"录音太短，请完整说出唤醒词"}"""
            val effective = if (read < total) pcm.copyOf(read) else pcm
            val detector = WakeWordDetector(this@MainActivity) {}
            val feats = detector.extractFeatures(effective)
            if (feats.isEmpty() || feats.size % WakeWordDetector.FEATURE_DIM != 0) {
                return """{"ok":false,"error":"未能提取语音特征，请再录一次"}"""
            }
            val templates = WakeWordDetector.loadTemplates(this@MainActivity).toMutableList()
            if (templates.size >= 3) templates.removeAt(0)
            templates.add(feats)
            WakeWordDetector.saveTemplates(this@MainActivity, templates)
            org.json.JSONObject().put("ok", true).put("templates", templates.size).toString()
        }.getOrElse { errJson(it.message) }

        /** 触发 OCR 记账截屏识别。configJson: {engine:"mlkit"|"online"|"web", url, key}；结果回传 window.__floatBridgeOnOcrResult。 */
        @JavascriptInterface
        fun ocrPaymentsCapture(configJson: String): String {
            val cfg = runCatching { org.json.JSONObject(configJson) }.getOrElse { org.json.JSONObject() }
            val engine = cfg.optString("engine", "mlkit")
            val url = cfg.optString("url", "")
            val key = cfg.optString("key", "")
            android.media.MediaProjectionCapture.capture(this@MainActivity) { bitmap ->
                if (bitmap == null) {
                    deliverOcrToWeb("""{"ok":false,"engine":"$engine","error":"截屏失败或未授权"}""")
                    return@capture
                }
                val scaled = scaleBitmapForOcr(bitmap)
                ShellOcr.recognize(this@MainActivity, scaled, engine, url, key) { json -> deliverOcrToWeb(json) }
            }
            return """{"ok":true,"capturing":true}"""
        }

        /** 读取 Gadgetbridge 导出的 SQLite 健康快照（步数/心率/压力/千卡/睡眠）。 */
        @JavascriptInterface
        fun readGadgetbridgeHealth(exportPath: String): String {
            return ShellHealth.readSnapshot(exportPath)
        }

        /** 一次性返回各权限层级状态（照搬 Operit 五级体系 + 华为 P60 适配，逐级可查可配）。 */
        @JavascriptInterface
        fun getPermissionStatus(customSuCommand: String? = null): String = runCatching {
            val granted = { perm: String ->
                androidx.core.content.ContextCompat.checkSelfPermission(this@MainActivity, perm) == android.content.pm.PackageManager.PERMISSION_GRANTED
            }
            val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
            val listeners = nm.enabledNotificationListeners ?: emptyArray()
            val notifListener = listeners.any { it.contains(packageName) }
            val overlay = android.provider.Settings.canDrawOverlays(this@MainActivity)
            val writeSettings = android.provider.Settings.System.canWrite(this@MainActivity)
            val storage = if (android.os.Build.VERSION.SDK_INT >= 30) android.os.Environment.isExternalStorageManager()
                else granted(android.Manifest.permission.READ_EXTERNAL_STORAGE)
            val suCmd = (customSuCommand ?: "").trim().ifEmpty { "su" }
            val rootAvailable = runCatching {
                val proc = Runtime.getRuntime().exec(arrayOf(suCmd, "-c", "id"))
                val out = proc.inputStream.bufferedReader().readText()
                val code = proc.waitFor()
                code == 0 && out.contains("uid=0")
            }.getOrDefault(false)
            org.json.JSONObject()
                .put("standard", org.json.JSONObject()
                    .put("location", granted(android.Manifest.permission.ACCESS_FINE_LOCATION) || granted(android.Manifest.permission.ACCESS_COARSE_LOCATION))
                    .put("microphone", granted(android.Manifest.permission.RECORD_AUDIO))
                    .put("storage", storage))
                .put("accessibility", accessibilityActive())
                .put("notificationListener", notifListener)
                .put("debugger", org.json.JSONObject()
                    .put("shell", true)
                    .put("file", storage))
                .put("admin", org.json.JSONObject()
                    .put("mediaProjection", MediaProjectionCapture.projectionToken != null)
                    .put("overlay", overlay)
                    .put("writeSettings", writeSettings))
                .put("root", org.json.JSONObject()
                    .put("available", rootAvailable)
                    .put("granted", rootAvailable)
                    .put("hint", if (rootAvailable) "Root 可用，已开高级能力" else "鸿蒙/EMUI 未开放 Root，此层不可用（可选层级）"))
                .toString()
        }.getOrElse { error: Throwable -> errJson(error.message) }

        /** 打开指定系统权限设置页。setting: accessibility/notification/overlay/write_settings/storage/location/microphone */
        @JavascriptInterface
        fun openPermissionSettings(setting: String): String = runCatching {
            val intent = when (setting) {
                "accessibility" -> android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)
                "notification" -> android.content.Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                "overlay" -> android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:$packageName"))
                "write_settings" -> android.content.Intent(android.provider.Settings.ACTION_MANAGE_WRITE_SETTINGS, android.net.Uri.parse("package:$packageName"))
                "storage" -> if (android.os.Build.VERSION.SDK_INT >= 30) android.content.Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, android.net.Uri.parse("package:$packageName"))
                    else android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                "location" -> android.content.Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
                "microphone" -> android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName"))
                else -> android.content.Intent(android.provider.Settings.ACTION_SETTINGS)
            }
            startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            """{"ok":true}"""
        }.getOrElse { errJson(it.message) }

        private fun scaleBitmapForOcr(bitmap: android.graphics.Bitmap): android.graphics.Bitmap {
            val maxEdge = 1800
            val w = bitmap.width
            val h = bitmap.height
            val scale = if (w > h) maxEdge.toFloat() / w else maxEdge.toFloat() / h
            if (scale >= 1f) return bitmap
            return android.graphics.Bitmap.createScaledBitmap(
                bitmap,
                (w * scale).toInt().coerceAtLeast(1),
                (h * scale).toInt().coerceAtLeast(1),
                true,
            )
        }
    }
}
