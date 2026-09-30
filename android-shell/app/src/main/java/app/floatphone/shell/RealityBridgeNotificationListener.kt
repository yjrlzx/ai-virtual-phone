package app.floatphone.shell

import android.app.Notification
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.os.Parcelable
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.LinkedHashMap
import java.util.regex.Pattern

/**
 * 现实桥·华为端通知监听。
 *
 * 收集系统通知（含微信/支付宝等聊天与支付 App），对外提供快照；
 * 并对支付类通知做基础解析（金额+收款方），作为自动记账的原料。
 * 由用户在系统设置→通知使用权里手动开启（声明见 AndroidManifest.xml）。
 */
object RealityBridgeNotificationStore {
    private data class Entry(
        val key: String,
        val packageName: String,
        val title: String,
        val text: String,
        val ts: Long,
        val avatar: String,
    )

    private val lock = Any()
    private val entries = LinkedHashMap<String, Entry>()

    /** 常见支付/记账来源包名：命中才进自动记账解析。 */
    private val PAY_PACKAGES = setOf(
        "com.tencent.mm",                 // 微信
        "com.eg.android.AlipayGphone",    // 支付宝
        "com.unionpay",                   // 云闪付
        "com.taobao.taobao",              // 淘宝
        "com.jingdong.app.mall",          // 京东
        "com.paypal.android.p2pmobile",
    )

    private val AMOUNT = Pattern.compile("[¥￥]\\s?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?\\s?元")

    private val MERCHANT = Pattern.compile(
        "向(.{1,12})(?:付款|转账|支付)|(?:付款给|支付给)(.{1,12})|(?:商户|收款方|收款人)[:：\\s]+(.{1,12})"
    )

    fun upsert(sbn: StatusBarNotification, ctx: Context) {
        val key = sbn.key
        val n = sbn.notification ?: return
        val extras = n.extras
        val title = extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val body = extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        val big = extras?.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim().orEmpty()
        val text = listOf(body, big).filter { it.isNotBlank() }.distinct().joinToString(" ")
        val avatar = extractAvatar(ctx, extras)
        synchronized(lock) {
            entries[key] = Entry(key, sbn.packageName ?: "", title, text, sbn.postTime, avatar)
            while (entries.size > 200) {
                val it = entries.entries.iterator()
                it.next()
                it.remove()
            }
        }
    }

    fun remove(sbn: StatusBarNotification) {
        synchronized(lock) { entries.remove(sbn.key) }
    }

    /** 全部通知快照（JSON 数组）。 */
    fun snapshot(limit: Int): String {
        synchronized(lock) {
            val list = entries.values.sortedByDescending { it.ts }.take(limit.coerceIn(1, 200))
            val sb = StringBuilder("[").append("\n")
            for (i in list.indices) {
                if (i > 0) sb.append(",\n")
                val e = list[i]
                sb.append("{")
                sb.append("\"pkg\":").append(jsonStr(e.packageName)).append(",")
                sb.append("\"title\":").append(jsonStr(e.title)).append(",")
                sb.append("\"text\":").append(jsonStr(e.text)).append(",")
                sb.append("\"ts\":").append(e.ts).append(",")
                sb.append("\"avatar\":").append(jsonStr(e.avatar))
                sb.append("}")
            }
            sb.append("\n]")
            return sb.toString()
        }
    }

    /** 解析出的支付记录（JSON 数组）：金额 + 收款方 + 来源 App。 */
    fun payments(limit: Int): String {
        synchronized(lock) {
            val out = ArrayList<Map<String, Any?>>()
            for (e in entries.values.sortedByDescending { it.ts }) {
                if (!PAY_PACKAGES.contains(e.packageName)) continue
                val amount = matchAmount(e.text) ?: continue
                out.add(
                    mapOf(
                        "pkg" to e.packageName,
                        "amount" to amount,
                        "merchant" to matchMerchant(e.text),
                        "title" to e.title,
                        "ts" to e.ts,
                    )
                )
                if (out.size >= limit.coerceAtLeast(1)) break
            }
            val sb = StringBuilder("[").append("\n")
            for (i in out.indices) {
                if (i > 0) sb.append(",\n")
                val m = out[i]
                sb.append("{")
                sb.append("\"pkg\":").append(jsonStr(m["pkg"]?.toString())).append(",")
                sb.append("\"amount\":").append(jsonStr(m["amount"]?.toString())).append(",")
                sb.append("\"merchant\":").append(jsonStr(m["merchant"]?.toString())).append(",")
                sb.append("\"title\":").append(jsonStr(m["title"]?.toString())).append(",")
                sb.append("\"ts\":").append(m["ts"])
                sb.append("}")
            }
            sb.append("\n]")
            return sb.toString()
        }
    }

    private fun matchAmount(text: String): String? {
        val m = AMOUNT.matcher(text)
        return if (m.find()) m.group().replace("元", "").trim() else null
    }

    private fun matchMerchant(text: String): String? {
        val m = MERCHANT.matcher(text)
        if (!m.find()) return null
        // 捕获组 1..N 才是收款方名，group(0) 是整体匹配，不能要
        for (g in 1..m.groupCount()) {
            val v = m.group(g)?.trim()
            if (!v.isNullOrBlank()) return v
        }
        return null
    }

    /** 从通知 extras 提取发送者头像：优先 EXTRA_LARGE_ICON（微信等聊天通知），退而求其次 EXTRA_PICTURE；压缩成 data URI。 */
    private fun extractAvatar(ctx: Context, extras: Bundle?): String {
        extras ?: return ""
        val bmp = runCatching {
            val obj: Parcelable? = extras.getParcelable<Parcelable>(Notification.EXTRA_LARGE_ICON)
                ?: extras.getParcelable<Parcelable>(Notification.EXTRA_PICTURE)
            when (obj) {
                is Bitmap -> obj
                is android.graphics.drawable.Icon -> drawableToBitmap(obj.loadDrawable(ctx))
                else -> null
            }
        }.getOrNull() ?: return ""
        return bitmapToDataUri(bmp)
    }

    private fun drawableToBitmap(d: Drawable?): Bitmap? {
        d ?: return null
        (d as? BitmapDrawable)?.bitmap?.let { return it }
        val w = d.intrinsicWidth.coerceAtLeast(1)
        val h = d.intrinsicHeight.coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        d.setBounds(0, 0, w, h)
        d.draw(canvas)
        return bmp
    }

    /** 最长边压到 96px、JPEG 质量 80 后 base64，避免单条通知几 MB。 */
    private fun bitmapToDataUri(src: Bitmap): String {
        return runCatching {
            val longest = maxOf(src.width, src.height)
            val bmp = if (longest > 96) {
                val ratio = 96f / longest
                Bitmap.createScaledBitmap(
                    src,
                    (src.width * ratio).toInt().coerceAtLeast(1),
                    (src.height * ratio).toInt().coerceAtLeast(1),
                    true,
                )
            } else {
                src
            }
            val baos = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 80, baos)
            "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        }.getOrDefault("")
    }

    private fun jsonStr(v: String?): String {
        if (v == null) return "null"
        return "\"" + v
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", " ")
            .replace("\r", " ") + "\""
    }
}

class RealityBridgeNotificationListener : NotificationListenerService() {
    override fun onListenerConnected() {
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            runCatching { activeNotifications?.forEach { RealityBridgeNotificationStore.upsert(it, this@RealityBridgeNotificationListener) } }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        RealityBridgeNotificationStore.upsert(sbn, this)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        RealityBridgeNotificationStore.remove(sbn)
    }
}
