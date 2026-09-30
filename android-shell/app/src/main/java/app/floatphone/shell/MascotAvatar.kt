package app.floatphone.shell

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * 角色头像共享缓存：chat-float 页经 FloatShell.setAvatar 上报后，
 * 悬浮球与悬浮窗标题栏共用同一份圆形位图。URL 持久化到 SharedPreferences，
 * 杀进程后再次打开悬浮球仍能恢复上次的头像。
 */
object MascotAvatar {

    private const val PREFS = "float_shell"
    private const val KEY_URL = "mascot_avatar_url"
    private const val KEY_USER_URL = "user_avatar_url"

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Volatile var url: String? = null
        private set

    @Volatile var bitmap: Bitmap? = null
        private set

    @Volatile var userBitmap: Bitmap? = null
        private set

    private val main = Handler(Looper.getMainLooper())

    private val observers = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    /** 注册头像变化回调（主线程触发）。返回的 lambda 用于反注册。 */
    fun addObserver(cb: () -> Unit) {
        observers.add(cb)
    }

    fun removeObserver(cb: () -> Unit) {
        observers.remove(cb)
    }

    /** 服务创建时调用：从 SharedPreferences 恢复角色与用户头像。 */
    fun initFromPrefs(ctx: Context) {
        prefs(ctx).getString(KEY_URL, null)?.takeIf { it.isNotBlank() }?.let {
            url = it
            applyUrl(ctx, it) { bmp -> bitmap = bmp }
        }
        prefs(ctx).getString(KEY_USER_URL, null)?.takeIf { it.isNotBlank() }?.let {
            applyUrl(ctx, it) { bmp -> userBitmap = bmp }
        }
    }

    /** 网页上报角色头像（data: URI 或同源/绝对 URL；blob: 等壳侧拉不到的格式忽略）。 */
    fun set(ctx: Context, raw: String?) {
        val u = raw?.trim().orEmpty()
        prefs(ctx).edit().putString(KEY_URL, u.ifBlank { null }).apply()
        if (u.isBlank()) {
            url = null
            bitmap = null
            notifyChange()
            return
        }
        url = u
        applyUrl(ctx, u) { bmp -> bitmap = bmp }
    }

    /** 网页上报用户头像（悬浮球右下角角标；未上报时角标显示默认图标）。 */
    fun setUser(ctx: Context, raw: String?) {
        val u = raw?.trim().orEmpty()
        prefs(ctx).edit().putString(KEY_USER_URL, u.ifBlank { null }).apply()
        if (u.isBlank()) {
            userBitmap = null
            notifyChange()
            return
        }
        applyUrl(ctx, u) { bmp -> userBitmap = bmp }
    }

    private fun applyUrl(ctx: Context, u: String, slot: (Bitmap?) -> Unit) {
        thread(name = "avatar-decode") {
            val bmp = runCatching { decode(u) }.getOrNull()
            main.post {
                slot(if (bmp != null) circularCrop(bmp) else null)
                notifyChange()
            }
        }
    }

    private fun notifyChange() {
        observers.forEach { cb -> main.post(cb) }
    }

    private fun decode(u: String): Bitmap? {
        if (u.startsWith("data:")) {
            val comma = u.indexOf(',')
            if (comma < 0) return null
            val bytes = Base64.decode(u.substring(comma + 1), Base64.DEFAULT)
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
        val absolute = when {
            u.startsWith("http://") || u.startsWith("https://") -> u
            u.startsWith("/") -> BuildConfig.SITE_URL.trimEnd('/') + u
            else -> return null
        }
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(absolute).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 8000
                requestMethod = "GET"
            }
            conn.inputStream.use { stream ->
                val opts = BitmapFactory.Options().apply { inSampleSize = 2 }
                BitmapFactory.decodeStream(stream, null, opts)
            }
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    /** 居中裁成正方形圆图，避免圆形 ImageView 拉伸变形。 */
    private fun circularCrop(src: Bitmap): Bitmap {
        val size = minOf(src.width, src.height)
        val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val rect = Rect(0, 0, size, size)
        canvas.drawARGB(0, 0, 0, 0)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        val left = (src.width - size) / 2
        val top = (src.height - size) / 2
        canvas.drawBitmap(src, Rect(left, top, left + size, top + size), rect, paint)
        return output
    }
}
