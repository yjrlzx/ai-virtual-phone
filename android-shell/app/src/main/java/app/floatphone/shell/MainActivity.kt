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

        /** 唤醒词命中回传网页（WakeWordService → window.__floatBridgeOnWakeWord）。
         *  命中成功时顺带拉起悬浮对话小窗，让用户直接对角色说话。 */
        fun deliverWakeWordToWeb(json: String) {
            val act = activeActivity ?: return
            val matched = runCatching { org.json.JSONObject(json).optBoolean("ok", false) }.getOrDefault(false)
            val b64 = android.util.Base64.encodeToString(json.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
            act.runOnUiThread {
                act.webView.evaluateJavascript("window.__floatBridgeOnWakeWord && window.__floatBridgeOnWakeWord(new TextDecoder('utf-8').decode(Uint8Array.from(atob('$b64'), function(c){return c.charCodeAt(0)})))", null)
                if (matched) runCatching { FloatingChatWindowService.show(act) }
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

        /** TTS 朗读事件回传网页（ShellTts → window.__floatBridgeOnTtsEvent）。 */
        fun deliverTtsEventToWeb(json: String) {
            val act = activeActivity ?: return
            val b64 = android.util.Base64.encodeToString(json.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
            act.runOnUiThread {
                act.webView.evaluateJavascript("window.__floatBridgeOnTtsEvent && window.__floatBridgeOnTtsEvent(new TextDecoder('utf-8').decode(Uint8Array.from(atob('$b64'), function(c){return c.charCodeAt(0)})))", null)
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

    /** 麦克风授权：录制唤醒词模板 / 开启唤醒服务时缺权限则弹运行时授权，授权后用户再点一次即可 */
    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* 授权结果由下一次 enrollWakeWord / startWakeWord 重新读取 */ }

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
                    Toast.makeText(this@MainActivity, "正在导出…", Toast.LENGTH_SHORT).show()
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
                Toast.makeText(this@MainActivity, "已开始下载到「下载」目录", Toast.LENGTH_SHORT).show()
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
        // SSE 长连接不依赖通知权限：即使用户拒绝通知授权，也要保持连接，
        // 之后在系统设置里开启通知后立刻能收到，不重启 App。
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        PushService.start(this)
    }

    /** 网页权限页调用：重新弹通知授权框（用户曾拒绝后引导用）。 */
    @JavascriptInterface
    fun requestNotificationPermission(): String = runCatching {
        if (Build.VERSION.SDK_INT < 33) return """{"ok":true,"already":true}"""
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) return """{"ok":true,"already":true}"""
        notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        """{"ok":true,"message":"已弹出通知授权框"}"""
    }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }

    override fun onDestroy() {
        if (Companion.activeActivity === this) Companion.activeActivity = null
        ShellTts.destroy()
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

        /** 系统状态快照（Operit 式一次性打包）：电量/是否充电/网络类型/经纬度/前台应用。
         *  静默读取、不弹权限框；拿不到的字段直接缺省，由网页层按现实桥开关过滤后注入 prompt。 */
        @JavascriptInterface
        fun getSystemContextSnapshot(): String = runCatching {
            val bm = getSystemService(BATTERY_SERVICE) as android.os.BatteryManager
            val batteryLevel = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val charging = runCatching {
                val sticky = registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
                val status = sticky?.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1) ?: -1
                val plugged = sticky?.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) ?: 0
                status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == android.os.BatteryManager.BATTERY_STATUS_FULL || plugged > 0
            }.getOrDefault(false)

            val cm = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
            val networkType = when {
                cm.activeNetwork == null -> "none"
                caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true -> "wifi"
                caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "mobile"
                else -> "other"
            }

            val obj = org.json.JSONObject()
                .put("ok", true)
                .put("batteryLevel", batteryLevel)
                .put("isCharging", charging)
                .put("networkType", networkType)

            // 定位：只读最后已知位置，不弹窗；没权限或没定位结果就不带 location 字段
            val hasFine = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            val hasCoarse = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (hasFine || hasCoarse) {
                runCatching {
                    val lm = getSystemService(LOCATION_SERVICE) as android.location.LocationManager
                    val loc = lm.getLastKnownLocation(android.location.LocationManager.GPS_PROVIDER)
                        ?: lm.getLastKnownLocation(android.location.LocationManager.NETWORK_PROVIDER)
                    if (loc != null) {
                        obj.put("location", org.json.JSONObject().put("lat", loc.latitude).put("lng", loc.longitude))
                    }
                }
            }
            val fg = RealityBridgeAccessibility.current()?.foregroundApp().orEmpty()
            if (fg.isNotEmpty()) obj.put("foregroundApp", fg)
            val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
            obj.put("isScreenOn", pm.isInteractive)
            obj.toString()
        }.getOrElse { errJson(it.message) }

        /** 唤醒屏幕（亮屏）。 */
        @JavascriptInterface
        fun wakeUp(): String = runCatching {
            val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
            @Suppress("DEPRECATION")
            pm.newWakeLock(
                android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "floatshell:wake",
            ).acquire(10_000L)
            org.json.JSONObject().put("ok", true).toString()
        }.getOrElse { errJson(it.message) }

        /** 截屏：返回 data URI（PNG base64）。异步等待最多 5s。 */
        @JavascriptInterface
        fun takeScreenshot(): String = runCatching {
            val svc = RealityBridgeAccessibility.current()
                ?: return """{"ok":false,"error":"无障碍服务未开启"}"""
            val latch = java.util.concurrent.CountDownLatch(1)
            var result: Map<String, Any?> = mapOf("ok" to false, "error" to "timeout")
            svc.takeScreenshotBase64 { r -> result = r; latch.countDown() }
            latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
            org.json.JSONObject(result as Map<*, *>).toString()
        }.getOrElse { errJson(it.message) }

        /** 定闹钟：交给系统闹钟 App（AlarmClock.ACTION_SET_ALARM，跳过 UI 直接设好）。 */
        @JavascriptInterface
        fun setAlarm(hour: Int, minute: Int, message: String): String = runCatching {
            val h = hour.coerceIn(0, 23)
            val m = minute.coerceIn(0, 59)
            val intent = android.content.Intent(android.provider.AlarmClock.ACTION_SET_ALARM)
                .putExtra(android.provider.AlarmClock.EXTRA_HOUR, h)
                .putExtra(android.provider.AlarmClock.EXTRA_MINUTES, m)
                .putExtra(android.provider.AlarmClock.EXTRA_MESSAGE, message)
                .putExtra(android.provider.AlarmClock.EXTRA_SKIP_UI, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            org.json.JSONObject().put("ok", true).put("at", "$h:${"%02d".format(m)}").toString()
        }.getOrElse { errJson(it.message) }

        /** 复制文本到系统剪贴板。 */
        @JavascriptInterface
        fun copyText(text: String): String = runCatching {
            val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            cm.setPrimaryClip(android.content.ClipData.newPlainText("float", text))
            org.json.JSONObject().put("ok", true).toString()
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
            RealityBridgeAccessibility.setLockedPackages(this@MainActivity, pkgs)
            org.json.JSONObject()
                .put("ok", true)
                .put("locked", RealityBridgeAccessibility.getLockedPackages().size)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 获取当前应用门禁锁定包名列表（JSON 数组）。 */
        @JavascriptInterface
        fun getLockedPackages(): String =
            org.json.JSONArray(RealityBridgeAccessibility.getLockedPackages()).toString()

        /** 单包锁定：minutes<=0 永久，上限 1440 分钟；message 为 char 留言。 */
        @JavascriptInterface
        fun lockPackage(packageName: String, minutes: Int, message: String): String = runCatching {
            RealityBridgeAccessibility.lockPackage(this@MainActivity, packageName.trim(), minutes, message)
            org.json.JSONObject().put("ok", true).toString()
        }.getOrElse { errJson(it.message) }

        @JavascriptInterface
        fun unlockPackage(packageName: String): String = runCatching {
            RealityBridgeAccessibility.unlockPackage(this@MainActivity, packageName.trim())
            org.json.JSONObject().put("ok", true).toString()
        }.getOrElse { errJson(it.message) }

        /** 无障碍点击（归一化 0..1000 坐标）。 */
        @JavascriptInterface
        fun tap(x: Int, y: Int): String =
            try {
                val r = RealityBridgeAccessibility.current()?.tapCoordinate(x, y)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 返回键：goBack 是 pressKey("back") 的便捷别名。 */
        @JavascriptInterface
        fun goBack(): String =
            try {
                val r = RealityBridgeAccessibility.current()?.pressKey("back")
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 回桌面。 */
        @JavascriptInterface
        fun goHome(): String =
            try {
                val r = RealityBridgeAccessibility.current()?.pressKey("home")
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 锁屏。 */
        @JavascriptInterface
        fun lockScreen(): String =
            try {
                val r = RealityBridgeAccessibility.current()?.pressKey("lock_screen")
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 下拉通知栏。 */
        @JavascriptInterface
        fun openNotificationShade(): String =
            try {
                val r = RealityBridgeAccessibility.current()?.pressKey("notifications")
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 读屏幕节点树（语义操作基础）。 */
        @JavascriptInterface
        fun readScreenTree(limit: Int): String =
            RealityBridgeAccessibility.current()?.dumpScreenTree(limit)
                ?: """{"ok":false,"error":"无障碍服务未开启"}"""

        /** 按文字点节点。 */
        @JavascriptInterface
        fun clickNodeByText(text: String): String =
            try {
                val r = RealityBridgeAccessibility.current()?.clickNodeByText(text)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 按描述点节点。 */
        @JavascriptInterface
        fun clickNodeByDescription(desc: String): String =
            try {
                val r = RealityBridgeAccessibility.current()?.clickNodeByDescription(desc)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 向前滚动。 */
        @JavascriptInterface
        fun scrollForward(): String =
            try {
                val r = RealityBridgeAccessibility.current()?.scrollForward()
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

        /** 对当前聚焦输入框写文字。 */
        @JavascriptInterface
        fun setTextOnFocusedField(text: String): String =
            try {
                val r = RealityBridgeAccessibility.current()?.setTextOnFocusedField(text)
                if (r == null) {
                    """{"ok":false,"error":"无障碍服务未开启"}"""
                } else {
                    org.json.JSONObject(r).toString()
                }
            } catch (t: Throwable) {
                errJson(t.message)
            }

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

        /** 读取系统控制所需权限的实时状态（供网页决定哪些项可操作、哪些要引导开权限）。 */
        @JavascriptInterface
        fun getSystemControlStatus(): String = runCatching {
            val btConnect = if (android.os.Build.VERSION.SDK_INT >= 31) {
                ContextCompat.checkSelfPermission(
                    this@MainActivity, android.Manifest.permission.BLUETOOTH_CONNECT,
                ) == PackageManager.PERMISSION_GRANTED
            } else true
            org.json.JSONObject()
                .put("ok", true)
                .put("writeSettings", Settings.System.canWrite(this@MainActivity))
                .put("shizuku", ShizukuAuthorizer.hasPermission())
                .put("bluetoothConnect", btConnect)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 请求定位运行时权限（ACCESS_FINE/COARSE_LOCATION，弹系统授权框）。 */
        @JavascriptInterface
        fun requestLocationPermission(): String = runCatching {
            androidx.core.app.ActivityCompat.requestPermissions(
                this@MainActivity,
                arrayOf(
                    android.Manifest.permission.ACCESS_FINE_LOCATION,
                    android.Manifest.permission.ACCESS_COARSE_LOCATION,
                ),
                1043,
            )
            """{"ok":true,"message":"已弹出定位授权框"}"""
        }.getOrElse { errJson(it.message) }

        /** 请求蓝牙运行时权限（API31+ BLUETOOTH_CONNECT，弹系统授权框）。 */
        @JavascriptInterface
        fun requestBluetoothPermission(): String = runCatching {
            if (android.os.Build.VERSION.SDK_INT < 31) return """{"ok":true,"already":true}"""
            androidx.core.app.ActivityCompat.requestPermissions(
                this@MainActivity,
                arrayOf(android.Manifest.permission.BLUETOOTH_CONNECT),
                1042,
            )
            """{"ok":true,"message":"已弹出蓝牙授权框"}"""
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

        /** 设置来电铃声：uri 为系统铃声 Uri；空串 = 只振动不响铃；未设置时跟随系统默认铃声。 */
        @JavascriptInterface
        fun setCallRingtone(uri: String): String {
            CallAlert.ringtoneUri = uri
            return """{"ok":true}"""
        }

        /** 读取当前来电铃声设置（uri 空串 = 未设置/跟随系统；网页显式设空串则只振动不响铃）。 */
        @JavascriptInterface
        fun getCallRingtone(): String {
            return org.json.JSONObject()
                .put("ok", true)
                .put("uri", CallAlert.ringtoneUri ?: "")
                .toString()
        }

        /** 开启常驻语音唤醒（前台服务）。configJson: {wakeWord, mode:"system"|"on_device"}；命中回传 window.__floatBridgeOnWakeWord。 */
        @JavascriptInterface
        fun startWakeWord(configJson: String): String {
            val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                this@MainActivity, android.Manifest.permission.RECORD_AUDIO,
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) {
                runOnUiThread { runCatching { micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO) } }
                return """{"ok":false,"error":"缺少麦克风权限，已弹出授权，授权后再开启一次"}"""
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
            if (!granted) {
                runOnUiThread { runCatching { micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO) } }
                return """{"ok":false,"error":"缺少麦克风权限，已弹出授权，授权后请再录一次"}"""
            }
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

        /** 文本朗读（TTS 队列）。configJson: {text, queue?, rate?, pitch?, languageTag?, apiKey?, voiceId?, baseUrl?, model?}；事件异步回传 window.__floatBridgeOnTtsEvent。 */
        @JavascriptInterface
        fun speak(configJson: String): String = runCatching {
            val cfg = org.json.JSONObject(configJson)
            val text = cfg.optString("text", "")
            if (text.isBlank()) return@runCatching """{"ok":false,"error":"朗读内容为空"}"""
            val queue = cfg.optBoolean("queue", true)
            val rate = cfg.optDouble("rate", 1.0).toFloat()
            val pitch = cfg.optDouble("pitch", 1.0).toFloat()
            val lang = cfg.optString("languageTag", "zh-CN")
            val apiKey = cfg.optString("apiKey", "")
            val voiceId = cfg.optString("voiceId", "")
            val baseUrl = cfg.optString("baseUrl", "")
            val model = cfg.optString("model", "")
            ShellTts.attach(this@MainActivity) { json -> deliverTtsEventToWeb(json) }
            ShellTts.speak(
                text,
                interrupt = !queue,
                rate = rate,
                pitch = pitch,
                languageTag = lang,
                apiKey = apiKey,
                voiceId = voiceId,
                baseUrl = baseUrl,
                model = model,
            )
            """{"ok":true}"""
        }.getOrElse { errJson(it.message) }

        /** 停止朗读：清空队列并立即停止当前朗读。 */
        @JavascriptInterface
        fun stopSpeak(): String {
            ShellTts.stop()
            return """{"ok":true}"""
        }

        /** TTS 状态：是否朗读中、队列长度、当前引擎包名（未初始化为空串）。 */
        @JavascriptInterface
        fun ttsStatus(): String = ShellTts.status().toString()

        /** 端上唤醒词模板数量。 */
        @JavascriptInterface
        fun listWakeTemplates(): String = runCatching {
            val n = WakeWordDetector.loadTemplates(this@MainActivity).size
            org.json.JSONObject().put("ok", true).put("count", n).toString()
        }.getOrElse { errJson(it.message) }

        /** 清空端上唤醒词模板。 */
        @JavascriptInterface
        fun clearWakeTemplates(): String = runCatching {
            val before = WakeWordDetector.loadTemplates(this@MainActivity).size
            WakeWordDetector.saveTemplates(this@MainActivity, emptyList())
            org.json.JSONObject().put("ok", true).put("cleared", before).toString()
        }.getOrElse { errJson(it.message) }

        /** 触发 OCR 记账截屏识别。configJson: {engine:"mlkit"|"online"|"web", url, key}；结果回传 window.__floatBridgeOnOcrResult。 */
        @JavascriptInterface
        fun ocrPaymentsCapture(configJson: String): String {
            val cfg = runCatching { org.json.JSONObject(configJson) }.getOrElse { org.json.JSONObject() }
            val engine = cfg.optString("engine", "mlkit")
            val url = cfg.optString("url", "")
            val key = cfg.optString("key", "")
            MediaProjectionCapture.capture(this@MainActivity) { bitmap ->
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
            val enabledListenerPackages =
                Settings.Secure.getString(
                    contentResolver,
                    "enabled_notification_listeners",
                )
                    ?.split(':')
                    ?.mapNotNull { android.content.ComponentName.unflattenFromString(it) }
                    ?.map { it.packageName }
                    ?.toSet()
                    ?: emptySet()
            val notifListener = packageName in enabledListenerPackages
            val overlay = android.provider.Settings.canDrawOverlays(this@MainActivity)
            val writeSettings = android.provider.Settings.System.canWrite(this@MainActivity)
            val batteryIgnoring = (getSystemService(POWER_SERVICE) as android.os.PowerManager)
                .isIgnoringBatteryOptimizations(packageName)
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
                    .put("file", storage)
                    .put("shizukuInstalled", ShizukuAuthorizer.isShizukuInstalled(this@MainActivity))
                    .put("shizukuRunning", ShizukuAuthorizer.isServiceRunning())
                    .put("shizukuPermission", ShizukuAuthorizer.hasPermission()))
                .put("admin", org.json.JSONObject()
                    .put("mediaProjection", MediaProjectionCapture.projectionToken != null)
                    .put("overlay", overlay)
                    .put("writeSettings", writeSettings)
                    .put("batteryOptimization", batteryIgnoring))
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
                "storage" -> if (android.os.Build.VERSION.SDK_INT >= 30) android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                    else android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName"))
                "location" -> android.content.Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
                "microphone" -> android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName"))
                "bluetooth" -> android.content.Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS)
                "wireless" -> android.content.Intent(android.provider.Settings.ACTION_WIRELESS_SETTINGS)
                "battery" -> android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                "app_details" -> android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName"))
                else -> android.content.Intent(android.provider.Settings.ACTION_SETTINGS)
            }
            startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            """{"ok":true}"""
        }.getOrElse { errJson(it.message) }

        /** 请求 Shizuku 权限（引导用户在 Shizuku 应用里授权） */
        @JavascriptInterface
        fun requestShizukuPermission(): String = runCatching {
            ShizukuAuthorizer.requestPermission { granted ->
                // 权限结果通过 toast 提示，不回传网页（Shizuku 授权是异步弹窗）
                android.widget.Toast.makeText(
                    this@MainActivity,
                    if (granted) "Shizuku 权限已授权" else "Shizuku 权限被拒绝",
                    android.widget.Toast.LENGTH_SHORT
                ).show()
            }
            """{"ok":true,"message":"已请求 Shizuku 权限，请在弹窗中授权"}"""
        }.getOrElse { errJson(it.message) }

        /** 通过 Shizuku 执行 shell 命令，返回 stdout/exitCode */
        @JavascriptInterface
        fun executeShellCommand(command: String): String = runCatching {
            if (!ShizukuAuthorizer.hasPermission()) {
                return@runCatching """{"ok":false,"error":"Shizuku 权限未授权"}"""
            }
            val result = ShizukuAuthorizer.executeShell(command)
            org.json.JSONObject()
                .put("ok", result.success)
                .put("stdout", result.stdout)
                .put("stderr", result.stderr)
                .put("exitCode", result.exitCode)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 列出已安装应用（照搬 Operit 应用管理）：包名 / 展示名 / 是否系统应用 / 是否启用。 */
        @JavascriptInterface
        fun getInstalledApps(): String = runCatching {
            val pm = packageManager
            val apps = pm.getInstalledApplications(0)
                .filter { it.packageName != packageName }
                .sortedWith(compareBy(
                    { (it.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0 },
                    { pm.getApplicationLabel(it).toString() },
                ))
            val arr = org.json.JSONArray()
            for (app in apps) {
                val enabled = runCatching {
                    pm.getApplicationEnabledSetting(app.packageName) ==
                        android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                }.getOrDefault(true)
                arr.put(org.json.JSONObject()
                    .put("pkg", app.packageName)
                    .put("label", pm.getApplicationLabel(app).toString())
                    .put("isSystem", (app.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0)
                    .put("isEnabled", enabled))
            }
            org.json.JSONObject()
                .put("ok", true)
                .put("count", apps.size)
                .put("apps", arr)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 打开悬浮角色对话小窗（网页/球都可调用）。 */
        @JavascriptInterface
        fun openFloatingChat() {
            runOnUiThread { runCatching { FloatingChatWindowService.show(this@MainActivity) } }
        }

        /** 安装内置 Shizuku APK：已装直接返回；否则拷到 cacheDir 用 FileProvider 唤起系统安装弹窗。 */
        @JavascriptInterface
        fun installBundledShizuku(): String = runCatching {
            if (ShizukuAuthorizer.isShizukuInstalled(this@MainActivity)) {
                return@runCatching """{"ok":true,"status":"already"}"""
            }
            val apk = java.io.File(cacheDir, "shizuku.apk")
            assets.open("shizuku.apk").use { input ->
                apk.outputStream().use { output -> input.copyTo(output) }
            }
            val uri = androidx.core.content.FileProvider.getUriForFile(
                this@MainActivity, "$packageName.fileprovider", apk,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            runOnUiThread { runCatching { startActivity(intent) } }
            """{"ok":true,"status":"installer_launched","message":"已唤起安装，请在系统弹窗完成安装（华为手机请允许「未知来源」安装）"}"""
        }.getOrElse { errJson(it.message) }

        /** 经 Shizuku 管理应用：force_stop / enable / disable / uninstall。 */
        @JavascriptInterface
        fun manageApp(action: String, packageName: String): String {
            if (!ShizukuAuthorizer.hasPermission()) return """{"ok":false,"error":"Shizuku 未授权"}"""
            val pkg = packageName.trim()
            if (pkg.isBlank()) return """{"ok":false,"error":"packageName 为空"}"""
            val cmd = when (action) {
                "force_stop" -> "am force-stop $pkg"
                "enable" -> "pm enable $pkg"
                "disable" -> "pm disable-user $pkg"
                "uninstall" -> "pm uninstall $pkg"
                else -> return """{"ok":false,"error":"未知 action：$action"}"""
            }
            val r = ShizukuAuthorizer.executeShell(cmd)
            return org.json.JSONObject()
                .put("ok", r.success)
                .put("action", action)
                .put("packageName", pkg)
                .put("output", r.stdout.ifBlank { r.stderr })
                .toString()
        }

        /** 经 Shizuku 开关飞行模式（写 global 设置 + 发系统广播）。未授权时如实返回错误，不假装成功。 */
        @JavascriptInterface
        fun setAirplaneMode(on: Boolean): String {
            if (!ShizukuAuthorizer.hasPermission()) {
                return """{"ok":false,"error":"系统限制：普通 App 无法直接切换飞行模式，需要先授权 Shizuku"}"""
            }
            val v = if (on) 1 else 0
            val state = if (on) "true" else "false"
            val r1 = ShizukuAuthorizer.executeShell("settings put global airplane_mode_on $v")
            if (!r1.success) {
                return org.json.JSONObject()
                    .put("ok", false)
                    .put("error", "写入飞行模式设置失败：${r1.stderr.ifBlank { r1.stdout }}")
                    .toString()
            }
            ShizukuAuthorizer.executeShell("am broadcast -a android.intent.action.AIRPLANE_MODE --ez state $state")
            return org.json.JSONObject()
                .put("ok", true)
                .put("on", on)
                .toString()
        }

        // ── 现实桥·补全 Operit 能力（点按 / Toast / 媒体键 / 蓝牙 / 文件 / 设置读写 / 用量 / 文件分享） ──

        /** 弹一个短 Toast。 */
        @JavascriptInterface
        fun toast(text: String): String = runCatching {
            runOnUiThread { Toast.makeText(this@MainActivity, text, Toast.LENGTH_SHORT).show() }
            """{"ok":true}"""
        }.getOrElse { errJson(it.message) }

        /** 媒体键控制：play_pause / next / previous / stop（优先 Shizuku，退回 Runtime）。 */
        @JavascriptInterface
        fun musicControl(action: String): String = runCatching {
            val code = when (action) {
                "play_pause" -> 85
                "next" -> 87
                "previous" -> 88
                "stop" -> 86
                else -> return@runCatching """{"ok":false,"error":"未知 action：$action"}"""
            }
            val usedShizuku = if (ShizukuAuthorizer.hasPermission()) {
                ShizukuAuthorizer.executeShell("input keyevent $code")
                true
            } else {
                Runtime.getRuntime().exec(arrayOf("input", "keyevent", code.toString())).waitFor()
                false
            }
            org.json.JSONObject()
                .put("ok", true)
                .put("action", action)
                .put("code", code)
                .put("viaShizuku", usedShizuku)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 蓝牙开关状态。 */
        @JavascriptInterface
        fun getBluetoothState(): String = runCatching {
            val adapter = android.bluetooth.BluetoothAdapter.getDefaultAdapter()
            org.json.JSONObject()
                .put("ok", true)
                .put("available", adapter != null)
                .put("enabled", adapter?.isEnabled ?: false)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 开关蓝牙（优先 Shizuku svc；API31+ 先校验 BLUETOOTH_CONNECT，无权限如实返回错误）。 */
        @JavascriptInterface
        fun setBluetoothEnabled(on: Boolean): String = runCatching {
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                val granted = ContextCompat.checkSelfPermission(
                    this@MainActivity, android.Manifest.permission.BLUETOOTH_CONNECT,
                ) == PackageManager.PERMISSION_GRANTED
                if (!granted) return@runCatching """{"ok":false,"error":"需要蓝牙权限，请先授权 BLUETOOTH_CONNECT"}"""
            }
            val adapter = android.bluetooth.BluetoothAdapter.getDefaultAdapter()
                ?: return@runCatching """{"ok":false,"error":"本机无蓝牙模块"}"""
            if (ShizukuAuthorizer.hasPermission()) {
                ShizukuAuthorizer.executeShell(if (on) "svc bluetooth enable" else "svc bluetooth disable")
            } else {
                @Suppress("DEPRECATION")
                if (on) adapter.enable() else adapter.disable()
            }
            // 回读真实状态，不假装成功
            Thread.sleep(400)
            org.json.JSONObject()
                .put("ok", true)
                .put("on", on)
                .put("enabled", adapter.isEnabled)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 列已配对蓝牙设备（API31+ 需 BLUETOOTH_CONNECT）。 */
        @JavascriptInterface
        fun listBondedDevices(): String = runCatching {
            if (Build.VERSION.SDK_INT >= 31) {
                val granted = ContextCompat.checkSelfPermission(
                    this@MainActivity, android.Manifest.permission.BLUETOOTH_CONNECT,
                ) == PackageManager.PERMISSION_GRANTED
                if (!granted) return@runCatching """{"ok":false,"error":"需要蓝牙权限"}"""
            }
            val adapter = android.bluetooth.BluetoothAdapter.getDefaultAdapter()
                ?: return@runCatching """{"ok":false,"error":"本机无蓝牙模块"}"""
            val arr = org.json.JSONArray()
            for (d in adapter.bondedDevices) {
                arr.put(org.json.JSONObject()
                    .put("name", runCatching { d.name }.getOrDefault(""))
                    .put("address", d.address))
            }
            org.json.JSONObject().put("ok", true).put("devices", arr).toString()
        }.getOrElse { errJson(it.message) }

        /** 写 UTF-8 文本文件。 */
        @JavascriptInterface
        fun writeFile(path: String, content: String): String = runCatching {
            if (path.isBlank()) return@runCatching """{"ok":false,"error":"path 为空"}"""
            val f = java.io.File(path)
            f.parentFile?.mkdirs()
            f.writeText(content, Charsets.UTF_8)
            org.json.JSONObject()
                .put("ok", true)
                .put("path", f.absolutePath)
                .put("bytes", f.length())
                .toString()
        }.getOrElse { errJson(it.message) }

        /**
         * 网页把已生成的 blob/导出文件落盘到公共「下载」目录（WebView 不会自动存 blob:）。
         * filename 由网页给；base64 为不带 data: 前缀的纯 base64。Q+ 走 MediaStore Downloads，低版本写公共目录并刷新媒体库。
         */
        @JavascriptInterface
        fun saveDownload(filename: String, base64: String): String = runCatching {
            val safe = filename.trim().ifBlank { "download.json" }
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/json")
                    put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values,
                ) ?: return@runCatching """{"ok":false,"error":"无法创建下载条目"}"""
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                values.clear()
                values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                val f = java.io.File(dir, safe)
                f.writeBytes(bytes)
                @Suppress("DEPRECATION")
                android.media.MediaScannerConnection.scanFile(this@MainActivity, arrayOf(f.absolutePath), null, null)
            }
            runOnUiThread {
                Toast.makeText(this@MainActivity, "已保存到下载目录：$safe", Toast.LENGTH_LONG).show()
            }
            org.json.JSONObject()
                .put("ok", true)
                .put("filename", safe)
                .put("bytes", bytes.size)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 删除文件或目录（目录递归删除）。 */
        @JavascriptInterface
        fun deleteFile(path: String): String = runCatching {
            if (path.isBlank()) return@runCatching """{"ok":false,"error":"path 为空"}"""
            val f = java.io.File(path)
            val ok = if (f.isDirectory) f.deleteRecursively() else f.delete()
            org.json.JSONObject().put("ok", ok).put("path", f.absolutePath).toString()
        }.getOrElse { errJson(it.message) }

        /** 建目录（含父目录）。 */
        @JavascriptInterface
        fun makeDirectory(path: String): String = runCatching {
            if (path.isBlank()) return@runCatching """{"ok":false,"error":"path 为空"}"""
            val f = java.io.File(path)
            val ok = f.mkdirs()
            org.json.JSONObject().put("ok", ok).put("path", f.absolutePath).toString()
        }.getOrElse { errJson(it.message) }

        /** 递归查找文件（最多 3 层、最多 100 条）。 */
        @JavascriptInterface
        fun findFiles(rootPath: String, query: String): String = runCatching {
            val root = java.io.File(rootPath)
            if (!root.exists() || !root.isDirectory) {
                return@runCatching """{"ok":false,"error":"根路径不是目录：$rootPath"}"""
            }
            val q = query.trim()
            val matches = org.json.JSONArray()
            var count = 0
            fun walk(dir: java.io.File, depth: Int) {
                if (depth > 3 || count >= 100) return
                val list = dir.listFiles() ?: return
                for (f in list) {
                    if (count >= 100) return
                    val hit = q.isEmpty() || f.name.contains(q, ignoreCase = true)
                    if (hit) {
                        matches.put(org.json.JSONObject()
                            .put("path", f.absolutePath)
                            .put("size", f.length())
                            .put("isDir", f.isDirectory))
                        count++
                    }
                    if (f.isDirectory) walk(f, depth + 1)
                }
            }
            walk(root, 0)
            org.json.JSONObject()
                .put("ok", true)
                .put("matches", matches)
                .put("count", count)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 读系统设置：namespace ∈ system/secure/global。 */
        @JavascriptInterface
        fun getSystemSetting(namespace: String, key: String): String = runCatching {
            val v: String? = when (namespace) {
                "system" -> Settings.System.getString(contentResolver, key)
                "secure" -> Settings.Secure.getString(contentResolver, key)
                "global" -> Settings.Global.getString(contentResolver, key)
                else -> return@runCatching """{"ok":false,"error":"未知 namespace：$namespace"}"""
            }
            org.json.JSONObject()
                .put("ok", true)
                .put("namespace", namespace)
                .put("key", key)
                .put("value", v ?: "")
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 写系统设置：namespace ∈ system/secure/global（写 system 需 WRITE_SETTINGS 权限）。 */
        @JavascriptInterface
        fun setSystemSetting(namespace: String, key: String, value: String): String = runCatching {
            if (namespace == "system" && !Settings.System.canWrite(this@MainActivity)) {
                return@runCatching """{"ok":false,"error":"需要「修改系统设置」权限"}"""
            }
            val ok: Boolean = when (namespace) {
                "system" -> Settings.System.putString(contentResolver, key, value)
                "secure" -> Settings.Secure.putString(contentResolver, key, value)
                "global" -> Settings.Global.putString(contentResolver, key, value)
                else -> return@runCatching """{"ok":false,"error":"未知 namespace：$namespace"}"""
            }
            org.json.JSONObject()
                .put("ok", ok)
                .put("namespace", namespace)
                .put("key", key)
                .put("value", value)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 今日应用使用时长 TOP20（需 PACKAGE_USAGE_STATS 权限，系统设置→应用→特殊权限里授予）。 */
        @JavascriptInterface
        fun getAppUsageTime(): String = runCatching {
            val usm = getSystemService(USAGE_STATS_SERVICE) as android.app.usage.UsageStatsManager
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
            if (stats != null) {
                for (s in stats) {
                    agg[s.packageName] = (agg[s.packageName] ?: 0L) + s.totalTimeInForeground
                }
            }
            val arr = org.json.JSONArray()
            agg.entries.sortedByDescending { it.value }.take(20).forEach { (pkg, ms) ->
                arr.put(org.json.JSONObject().put("pkg", pkg).put("totalTimeMs", ms))
            }
            org.json.JSONObject().put("ok", true).put("usages", arr).toString()
        }.getOrElse { errJson(it.message) }

        /** 用系统查看器打开文件（FileProvider 临时授权读 URI）。 */
        @JavascriptInterface
        fun openFile(path: String): String = runCatching {
            val f = java.io.File(path)
            if (!f.exists()) return@runCatching """{"ok":false,"error":"文件不存在：$path"}"""
            val ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(f.name).lowercase()
            val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
            val uri = androidx.core.content.FileProvider.getUriForFile(
                this@MainActivity, "$packageName.fileprovider", f,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            runOnUiThread { runCatching { startActivity(intent) } }
            org.json.JSONObject()
                .put("ok", true)
                .put("path", f.absolutePath)
                .put("mime", mime)
                .toString()
        }.getOrElse { errJson(it.message) }

        /** 通过系统分享面板发送文件（FileProvider 临时授权读 URI）。 */
        @JavascriptInterface
        fun shareFile(path: String, mime: String): String = runCatching {
            val f = java.io.File(path)
            if (!f.exists()) return@runCatching """{"ok":false,"error":"文件不存在：$path"}"""
            val uri = androidx.core.content.FileProvider.getUriForFile(
                this@MainActivity, "$packageName.fileprovider", f,
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                setType(mime.ifBlank { "*/*" })
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            runOnUiThread {
                runCatching {
                    startActivity(Intent.createChooser(send, "分享").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
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
