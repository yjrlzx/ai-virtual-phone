package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 推送前台服务：自建 SSE 长连接，不依赖 Google 服务，也不依赖 Supabase Realtime。
 *
 * 原理：借 WebView 里已登录的站点 Cookie 调 /api/auth/me 拿到当前用户 id，
 * 注册一条 shell:<userId> 的合成订阅后，用 OkHttp GET /api/push/stream
 * 保持 SSE 长连接，逐行读 `data: {...}` 事件。
 * 服务端（测试按钮 / 快捷指令 / 定时调度器）发消息时经进程内 EventEmitter
 * 推到本连接：type=message 弹普通通知，type=call 直接拉起全屏来电页。
 * App 被杀也能收（前台服务存活期间）。
 */
class PushService : Service() {

    companion object {
        private const val CH_KEEPALIVE = "shell_keepalive"
        private const val CH_MESSAGES = "shell_messages"
        private const val CH_CALLS = "shell_calls"
        private const val NOTIF_FG_ID = 1
        private var running = false

        fun start(context: Context) {
            if (running) return
            val intent = Intent(context, PushService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    @Volatile private var sseBody: ResponseBody? = null
    private var stopped = false
    private var notifId = 100
    private var shellSubRegistered = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        createChannels()
        startForeground(NOTIF_FG_ID, buildKeepAliveNotification("等待连接…"))
        thread(name = "shell-push-loop") { connectionLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopped = true
        running = false
        runCatching { sseBody?.close() }
        super.onDestroy()
    }

    // ── 连接循环：拿登录态 → 连 SSE → 断线退避重连 ──
    private fun connectionLoop() {
        var backoffSec = 5L
        while (!stopped) {
            val cookie = CookieManager.getInstance().getCookie(MainActivity.SITE_URL)
            if (cookie.isNullOrEmpty()) {
                updateKeepAlive("未登录，稍后重试")
                sleepSec(60); continue
            }
            val me = getJson(cookie, "/api/auth/me")
            if (me == null) {
                updateKeepAlive("站点不可达，稍后重试")
                sleepSec(60); continue
            }
            val userId = me.optJSONObject("account")?.optString("id").orEmpty()
            if (userId.isEmpty()) {
                updateKeepAlive("未登录，稍后重试")
                sleepSec(60); continue
            }
            registerShellSubscription(cookie, userId)
            updateKeepAlive("已连接，等待角色消息")
            runSse(cookie)
            if (stopped) break
            updateKeepAlive("连接断开，重连中…")
            sleepSec(backoffSec)
            backoffSec = (backoffSec * 2).coerceAtMost(120)
        }
    }

    private fun getJson(cookie: String, path: String): JSONObject? {
        val request = Request.Builder()
            .url("${MainActivity.SITE_URL}$path")
            .header("Cookie", cookie)
            .header("Accept", "application/json")
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            return JSONObject(response.body?.string() ?: return null)
        }
    }

    /**
     * 在站点注册一条合成推送订阅（endpoint = shell:<userId>）。
     * 作用是让服务端知道这个账号有壳在线，并让"是否已订阅"门控放行；
     * 服务端不会对它做 Web Push 投递，而是走 SSE 长连接推送。
     */
    private fun registerShellSubscription(cookie: String, userId: String) {
        if (shellSubRegistered) return
        runCatching {
            val body = JSONObject()
                .put("endpoint", "shell:$userId")
                .put(
                    "keys",
                    JSONObject().put("p256dh", "shell").put("auth", "shell"),
                )
                .toString()
                .toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("${MainActivity.SITE_URL}/api/push/subscribe")
                .header("Cookie", cookie)
                .post(body)
                .build()
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) shellSubRegistered = true
            }
        }
    }

    /** 挂住 SSE 流直到断开；返回前不关 cookie，重连由外层循环负责。 */
    private fun runSse(cookie: String) {
        val request = Request.Builder()
            .url("${MainActivity.SITE_URL}/api/push/stream")
            .header("Cookie", cookie)
            .header("Accept", "text/event-stream")
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return
            val body = response.body ?: return
            sseBody = body
            val reader = body.byteStream().bufferedReader()
            val dataBuf = StringBuilder()
            while (!stopped) {
                val line = runCatching { reader.readLine() }.getOrNull() ?: break
                if (line.startsWith("data:")) {
                    dataBuf.append(line.removePrefix("data:").trimStart())
                } else if (line.isEmpty()) {
                    if (dataBuf.isNotEmpty()) {
                        handleSseData(dataBuf.toString())
                        dataBuf.setLength(0)
                    }
                }
                // 注释行（心跳 ": ping"）直接忽略
            }
        }
        sseBody = null
    }

    private fun handleSseData(raw: String) {
        runCatching {
            val msg = JSONObject(raw)
            val type = msg.optString("type")
            if (type == "hello" || type == "lifeline_sync") return
            val title = msg.optString("title").ifEmpty { "小手机" }
            val text = msg.optString("body")
            // 来电：全屏来电通知（任何一步失败回落普通通知，主路不受影响）
            if (type == "call") {
                val shown = runCatching {
                    showIncomingCallNotification(
                        msg.optString("characterName").ifEmpty { title },
                        msg.optString("sessionId"),
                        msg.optLong("callTs", System.currentTimeMillis()),
                    )
                }.isSuccess
                if (shown) return
            }
            // 通知被系统关闭时 heads-up 会被静默吞掉——常驻通知里如实提示，
            // 用户才知道要去系统设置开通知，而不是以为壳没连上。
            if (notificationsBlocked()) {
                updateKeepAlive("收到 ${title} 的消息，但通知权限被关闭，点此去系统设置开启")
                return
            }
            showMessageNotification(title, text.ifEmpty { "有新消息" })
        }
    }

    // ── 通知 ──
    /** 系统把本 App 通知整体关掉时，heads-up 会被静默丢弃——常驻通知如实提示，不假装收到。 */
    private fun notificationsBlocked(): Boolean {
        val manager = getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return true
        val channel = manager.getNotificationChannel(CH_MESSAGES) ?: return false
        return channel.importance == NotificationManager.IMPORTANCE_NONE
    }

    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CH_KEEPALIVE, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "维持角色消息接收通道（可在此关闭常驻通知的显示）"
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_MESSAGES, "角色消息", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色发来的离线消息"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_CALLS, "角色来电", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色打来的语音电话（铃声与振动由 CallAlert 循环控制）"
                setSound(null, null)
                enableVibration(false) // 振动由 CallAlert 循环控制，渠道自带的一次性振动关掉
            },
        )
    }

    private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun buildKeepAliveNotification(text: String): Notification =
        NotificationCompat.Builder(this, CH_KEEPALIVE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()

    private fun updateKeepAlive(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIF_FG_ID, buildKeepAliveNotification(text))
    }

    /**
     * 全屏来电通知：锁屏/熄屏直接弹 IncomingCallActivity，亮屏时是带
     * 接听/拒接按钮的 heads-up。振动循环 + 55s 超时未接由 CallAlert 管。
     */
    private fun showIncomingCallNotification(characterName: String, sessionId: String, callTs: Long) {
        val fullScreen = Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(IncomingCallActivity.EXTRA_SESSION_ID, sessionId)
            putExtra(IncomingCallActivity.EXTRA_CHARACTER_NAME, characterName)
            putExtra(IncomingCallActivity.EXTRA_CALL_TS, callTs)
        }
        val fullScreenPending = PendingIntent.getActivity(
            this, 60, fullScreen,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fun buildAction(actionName: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
            this, code,
            Intent(this, CallActionReceiver::class.java).apply {
                action = actionName
                putExtra(CallActionReceiver.EXTRA_SESSION_ID, sessionId)
                putExtra(CallActionReceiver.EXTRA_CALL_TS, callTs)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(characterName)
            .setContentText("语音来电…")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreenPending, true)
            .setContentIntent(fullScreenPending)
            .addAction(0, "拒接", buildAction(CallActionReceiver.ACTION_DECLINE, 61))
            .addAction(0, "接听", buildAction(CallActionReceiver.ACTION_ANSWER, 62))
            .build()
        getSystemService(NotificationManager::class.java).notify(CallAlert.NOTIF_CALL_ID, notification)
        CallAlert.start(this, sessionId, characterName) {
            // 超时未接：收场 + 换一条"未接来电"普通通知（正文消息本来就会进聊天）
            CallAlert.stop(this)
            runCatching { showMissedCallNotification(characterName) }
        }
    }

    private fun showMissedCallNotification(characterName: String) {
        val notification = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(characterName)
            .setContentText("未接来电")
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java).notify(CallAlert.NOTIF_MISSED_ID, notification)
    }

    private fun showMessageNotification(title: String, body: String) {
        val notification = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .build()
        getSystemService(NotificationManager::class.java).notify(notifId++, notification)
        if (notifId > 400) notifId = 100
    }

    private fun sleepSec(sec: Long) {
        runCatching { Thread.sleep(sec * 1000) }
    }
}
