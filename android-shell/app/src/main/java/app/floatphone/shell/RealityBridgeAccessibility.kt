package app.floatphone.shell

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.util.concurrent.CopyOnWriteArraySet

/**
 * 现实桥·华为端无障碍服务。
 *
 * 提供掌心窗式读屏能力：当前窗口节点树、按可见文字定位并点击、输入文字，以及应用门禁锁 App。
 * 由用户在系统设置→无障碍里手动开启（声明见 accessibility_service_config.xml）。
 * 未开启时相关命令返回明确错误，不静默失败。
 */
class RealityBridgeAccessibility : AccessibilityService() {

    companion object {
        private var instance: RealityBridgeAccessibility? = null
        fun active(): Boolean = instance != null
        fun current(): RealityBridgeAccessibility? = instance

        private const val PREFS = "float_shell"
        private const val KEY_LOCKED = "locked_packages"
        private const val KEY_LOCK_META = "locked_packages_meta"

        /** 应用门禁锁定包名集合：命中即强制拦截回桌面。 */
        private val lockedPackages = CopyOnWriteArraySet<String>()
        private var lastEnforced = 0L

        /** 每条锁定的元数据：到期时间戳（0=永久）+ char 留言。 */
        class LockEntry(val pkg: String, val expiresAt: Long, val message: String) {
            fun expired(now: Long): Boolean = expiresAt in 1..now
            fun minutesLeft(now: Long): Long =
                if (expiresAt <= 0L) -1L else ((expiresAt - now + 59_999L) / 60_000L).coerceAtLeast(0)
        }
        private val lockMeta = java.util.concurrent.ConcurrentHashMap<String, LockEntry>()

        /** 专注模式截止时间戳（ms），在此之前拦截除壳自身外的一切前台 App。 */
        private var focusUntil = 0L

        /** 开启专注模式 durationMin 分钟，期间锁定全机，可随时调用关闭。 */
        fun setFocusMode(durationMin: Int) {
            // 防御性上限：网页侧 clamp 1..240 分钟，原生侧再兜一层，防异常入参把锁定拉到数天；<=0 表示关闭
            val min = durationMin.coerceIn(0, 240)
            focusUntil = if (min > 0) System.currentTimeMillis() + min * 60_000L else 0L
        }

        fun isFocusing(): Boolean = System.currentTimeMillis() < focusUntil

        /** 服务连接时从 SharedPreferences 恢复锁定列表（进程死亡/服务重启后不丢）。 */
        fun loadLockedPackages(ctx: android.content.Context) {
            val prefs = ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            val saved = prefs.getStringSet(KEY_LOCKED, emptySet()) ?: emptySet()
            lockedPackages.clear()
            lockedPackages.addAll(saved.filter { it.isNotBlank() })
            lockMeta.clear()
            runCatching {
                val arr = org.json.JSONArray(prefs.getString(KEY_LOCK_META, "[]"))
                val now = System.currentTimeMillis()
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val pkg = o.optString("pkg")
                    if (pkg.isBlank()) continue
                    val entry = LockEntry(pkg, o.optLong("expiresAt", 0L), o.optString("message", ""))
                    if (entry.expired(now)) continue
                    lockMeta[pkg] = entry
                    lockedPackages.add(pkg)
                }
            }
        }

        private fun persistLockedPackages(ctx: android.content.Context) {
            val arr = org.json.JSONArray()
            for ((pkg, e) in lockMeta) {
                arr.put(org.json.JSONObject().put("pkg", pkg).put("expiresAt", e.expiresAt).put("message", e.message))
            }
            ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
                .edit()
                .putStringSet(KEY_LOCKED, lockedPackages.toSet())
                .putString(KEY_LOCK_META, arr.toString())
                .apply()
        }

        fun setLockedPackages(ctx: android.content.Context, pkgs: List<String>) {
            lockedPackages.clear()
            lockMeta.clear()
            lockedPackages.addAll(pkgs.filter { it.isNotBlank() })
            persistLockedPackages(ctx)
            recheckGate()
        }

        /** 带时长 + 留言的锁定：minutes<=0 永久；上限 1440 分钟（24h）。 */
        fun lockPackage(ctx: android.content.Context, pkg: String, minutes: Int, message: String) {
            if (pkg.isBlank()) return
            val m = minutes.coerceIn(0, 1440)
            val expiresAt = if (m > 0) System.currentTimeMillis() + m * 60_000L else 0L
            lockMeta[pkg] = LockEntry(pkg, expiresAt, message.trim())
            lockedPackages.add(pkg)
            persistLockedPackages(ctx)
            recheckGate()
        }

        fun unlockPackage(ctx: android.content.Context, pkg: String) {
            lockedPackages.remove(pkg)
            lockMeta.remove(pkg)
            persistLockedPackages(ctx)
        }

        /** 某包的当前锁定元数据；已过期自动清除并返回 null。 */
        fun getLockEntry(pkg: String): LockEntry? {
            val e = lockMeta[pkg] ?: return null
            if (e.expired(System.currentTimeMillis())) {
                lockedPackages.remove(pkg)
                lockMeta.remove(pkg)
                return null
            }
            return e
        }

        fun listActiveLocks(): List<LockEntry> {
            val now = System.currentTimeMillis()
            val expired = lockMeta.values.filter { it.expired(now) }.map { it.pkg }
            expired.forEach { lockedPackages.remove(it); lockMeta.remove(it) }
            return lockMeta.values.sortedBy { it.pkg }
        }

        fun addLockedPackage(ctx: android.content.Context, pkg: String) {
            if (pkg.isNotBlank()) {
                lockedPackages.add(pkg)
                persistLockedPackages(ctx)
            }
            recheckGate()
        }

        /** 锁定后立即检查当前前台是否命中，命中即立刻拦截（补窗口事件兜底）。 */
        fun recheckGate() {
            val svc = current() ?: return
            val pkg = svc.foregroundApp().ifBlank { return }
            svc.maybeEnforceGate(pkg)
        }

        fun removeLockedPackage(ctx: android.content.Context, pkg: String) {
            lockedPackages.remove(pkg)
            persistLockedPackages(ctx)
        }

        fun getLockedPackages(): List<String> = lockedPackages.toList()

        fun isLockedPackage(pkg: String): Boolean = lockedPackages.contains(pkg)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        loadLockedPackages(this)
        // 兜底轮询：华为/鸿蒙 ROM 有时不发 WINDOW_STATE_CHANGED，每 1.5s 检查一次前台包名是否命中锁。
        pollHandler = android.os.Handler(android.os.Looper.getMainLooper())
        pollRunnable = object : Runnable {
            override fun run() {
                runCatching { maybeEnforceGate(foregroundApp().ifBlank { null }) }
                pollHandler?.postDelayed(this, 1500L)
            }
        }
        pollHandler?.post(pollRunnable!!)
    }

    private var pollHandler: android.os.Handler? = null
    private var pollRunnable: Runnable? = null

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val e = event ?: return
        if (e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            || e.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED
        ) {
            maybeEnforceGate(e.packageName?.toString())
        }
    }

    /**
     * 应用门禁 + 专注模式：前台包名命中锁定列表，或专注模式期间除壳自身外的一切前台 App，
     * 都强制回桌面。带 1.5 秒冷却，避免同包名连续窗口事件重复触发；切走后自动解除。
     */
    private fun maybeEnforceGate(pkg: String?) {
        if (pkg.isNullOrBlank()) return
        val now = System.currentTimeMillis()
        val focusing = now < focusUntil
        // 过期锁定自动清除，不再拦截
        val entry = if (lockedPackages.contains(pkg)) getLockEntry(pkg) else null
        val locked = entry != null
        if (!focusing && !locked) return
        // 专注模式不锁壳自身（否则把现实桥网页也锁掉，无法退出）
        if (focusing && pkg == applicationContext.packageName) return
        if (now - lastEnforced < 500L) return
        lastEnforced = now
        if (locked) {
            runCatching {
                val e = entry ?: return@runCatching
                val intent = android.content.Intent(this, GateBlockActivity::class.java)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(GateBlockActivity.EXTRA_PKG, pkg)
                    .putExtra(GateBlockActivity.EXTRA_MESSAGE, e.message)
                    .putExtra(GateBlockActivity.EXTRA_EXPIRES_AT, e.expiresAt)
                startActivity(intent)
            }
        } else {
            performGlobalAction(GLOBAL_ACTION_HOME)
        }
    }

    /** 屏幕休息：设定 seconds 秒后自动息屏。 */
    fun screenBreak(seconds: Int) {
        if (seconds <= 0) return
        // 防御性上限：网页侧 5..3600 秒，原生侧兜顶防超长等待线程
        val sec = seconds.coerceAtMost(3600)
        Thread {
            try { Thread.sleep(sec * 1000L) } catch (_: InterruptedException) { return@Thread }
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
            }
        }.start()
    }

    override fun onInterrupt() { /* no-op */ }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    /** 返回当前前台窗口的可读节点树 JSON（掌心窗 getScreenNodes 的华为端实现）。
     *  每个节点带 text / content-desc / class / packageName / clickable / 可点击中心坐标 bounds，
     *  成功时直接返回 JSON 数组（保持既有网页契约）。 */
    fun dumpScreenTree(limit: Int = 300): String {
        return try {
            val root = rootInActiveWindow ?: return """{"ok":false,"error":"无障碍已开但取不到当前窗口"}"""
            val arr = org.json.JSONArray()
            collectNodes(root, arr, limit)
            arr.toString()
        } catch (t: Throwable) {
            """{"ok":false,"error":${jsonStr(t.message)}}"""
        }
    }

    private fun collectNodes(node: AccessibilityNodeInfo, out: org.json.JSONArray, limit: Int) {
        if (out.length() >= limit) return
        val text = node.text?.toString()
        val desc = node.contentDescription?.toString()
        // 可见且"有意义"的节点：带文字/描述、可点击、可编辑、可勾选、可滚动——其余纯布局容器跳过
        val interesting = !text.isNullOrBlank() || !desc.isNullOrBlank() ||
            node.isClickable || node.isEditable || node.isCheckable || node.isScrollable
        if (interesting) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            val bounds = org.json.JSONObject()
                .put("l", rect.left)
                .put("t", rect.top)
                .put("r", rect.right)
                .put("b", rect.bottom)
                .put("cx", rect.centerX())
                .put("cy", rect.centerY())
            out.put(
                org.json.JSONObject()
                    .put("text", text ?: org.json.JSONObject.NULL)
                    .put("desc", desc ?: org.json.JSONObject.NULL)
                    .put("id", node.viewIdResourceName ?: org.json.JSONObject.NULL)
                    .put("class", node.className?.toString() ?: org.json.JSONObject.NULL)
                    .put("pkg", node.packageName?.toString() ?: org.json.JSONObject.NULL)
                    .put("clickable", node.isClickable)
                    .put("editable", node.isEditable)
                    .put("checkable", node.isCheckable)
                    .put("rect", rect.flattenToString())
                    .put("bounds", bounds),
            )
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child -> collectNodes(child, out, limit) }
        }
    }

    /** 按可见文字定位第一个可点击节点并触发点击。返回是否找到并点击。 */
    fun clickText(text: String): Map<String, Any?> = clickNodeByText(text)

    /** 按文字定位可点击节点并点击（语义操作，不依赖坐标）。 */
    fun clickNodeByText(text: String): Map<String, Any?> {
        return try {
            val root = rootInActiveWindow ?: return mapOf("ok" to false, "error" to "取不到当前窗口")
            val node = findNodeByText(root, text, clickable = true)
                ?: return mapOf("ok" to false, "error" to "没找到可点击的文字")
            if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                mapOf("ok" to true)
            } else {
                mapOf("ok" to false, "error" to "点击动作被系统拒绝")
            }
        } catch (t: Throwable) {
            mapOf("ok" to false, "error" to (t.message ?: "点击失败"))
        }
    }

    /** 按 contentDescription 定位可点击节点并点击。 */
    fun clickNodeByDescription(desc: String): Map<String, Any?> {
        return try {
            val root = rootInActiveWindow ?: return mapOf("ok" to false, "error" to "取不到当前窗口")
            var found: AccessibilityNodeInfo? = null
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            while (queue.isNotEmpty() && found == null) {
                val node = queue.removeFirst()
                val d = node.contentDescription?.toString()
                if (!d.isNullOrBlank() && d.contains(desc) && node.isClickable) {
                    found = node
                    break
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let { queue.add(it) }
            }
            val target = found ?: return mapOf("ok" to false, "error" to "没找到可点击的描述")
            if (target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) mapOf("ok" to true)
            else mapOf("ok" to false, "error" to "点击动作被系统拒绝")
        } catch (t: Throwable) {
            mapOf("ok" to false, "error" to (t.message ?: "点击失败"))
        }
    }

    /** 向前滚动当前屏幕里第一个可滚动节点。 */
    fun scrollForward(): Map<String, Any?> {
        return try {
            val root = rootInActiveWindow ?: return mapOf("ok" to false, "error" to "取不到当前窗口")
            var target: AccessibilityNodeInfo? = null
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            while (queue.isNotEmpty() && target == null) {
                val node = queue.removeFirst()
                if (node.isScrollable) { target = node; break }
                for (i in 0 until node.childCount) node.getChild(i)?.let { queue.add(it) }
            }
            val t = target ?: return mapOf("ok" to false, "error" to "当前屏幕没有可滚动区域")
            if (t.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) mapOf("ok" to true)
            else mapOf("ok" to false, "error" to "滚动被系统拒绝")
        } catch (t: Throwable) {
            mapOf("ok" to false, "error" to (t.message ?: "滚动失败"))
        }
    }

    /** 对当前聚焦的输入框执行 ACTION_SET_TEXT。 */
    fun setTextOnFocusedField(text: String): Map<String, Any?> {
        return try {
            val root = rootInActiveWindow ?: return mapOf("ok" to false, "error" to "取不到当前窗口")
            val editable = findFocusedEditable(root)
                ?: return mapOf("ok" to false, "error" to "当前没有聚焦的输入框")
            val args = android.os.Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            if (editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) mapOf("ok" to true)
            else mapOf("ok" to false, "error" to "写入文字被系统拒绝")
        } catch (t: Throwable) {
            mapOf("ok" to false, "error" to (t.message ?: "输入失败"))
        }
    }

    /** 截屏：API 30+ 用 AccessibilityService.takeScreenshot，返回 data URI（PNG base64）。 */
    fun takeScreenshotBase64(cb: (Map<String, Any?>) -> Unit) {
        if (android.os.Build.VERSION.SDK_INT < 30) {
            cb(mapOf("ok" to false, "error" to "系统版本不支持无障碍截屏（需 Android 11+）"))
            return
        }
        runCatching {
            // SCREENSHOT_TYPE_ACTIVE_WINDOW = 1（API 30）
            takeScreenshot(
                1,
                java.util.concurrent.Executors.newSingleThreadExecutor(),
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(screenshot: android.accessibilityservice.AccessibilityService.ScreenshotResult) {
                        runCatching {
                            val bitmap = android.graphics.Bitmap.wrapHardwareBuffer(
                                screenshot.hardwareBuffer, screenshot.colorSpace,
                            )
                            val bytes = java.io.ByteArrayOutputStream()
                            bitmap?.copy(android.graphics.Bitmap.Config.ARGB_8888, true)
                                ?.compress(android.graphics.Bitmap.CompressFormat.PNG, 80, bytes)
                            bitmap?.recycle()
                            screenshot.hardwareBuffer.close()
                            val b64 = android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP)
                            cb(mapOf("ok" to true, "dataUri" to "data:image/png;base64,$b64"))
                        }.onFailure { cb(mapOf("ok" to false, "error" to (it.message ?: "截图失败"))) }
                    }

                    override fun onFailure(errorCode: Int) {
                        cb(mapOf("ok" to false, "error" to "截屏失败 code=$errorCode"))
                    }
                },
            )
        }.onFailure { cb(mapOf("ok" to false, "error" to (it.message ?: "截屏调用失败"))) }
    }

    /** 向输入框写入文字：优先当前焦点可编辑节点，其次按可见文字定位输入框。 */
    fun inputText(text: String): Map<String, Any?> {
        return try {
            val root = rootInActiveWindow ?: return mapOf("ok" to false, "error" to "取不到当前窗口")
            val editable = findFocusedEditable(root)
                ?: findNodeByText(root, text, clickable = true)
                ?: return mapOf("ok" to false, "error" to "没找到输入框")
            val args = android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
            if (editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                mapOf("ok" to true)
            } else {
                mapOf("ok" to false, "error" to "写入文字被系统拒绝")
            }
        } catch (t: Throwable) {
            mapOf("ok" to false, "error" to (t.message ?: "输入失败"))
        }
    }

    /** 找到当前持有焦点的可编辑输入框节点。 */
    private fun findFocusedEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.isEditable && node.isFocused) return node
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }
        return null
    }

    /** 按文字找节点；优先找可点击的，否则找带该文本的输入框。 */
    private fun findNodeByText(root: AccessibilityNodeInfo, text: String, clickable: Boolean): AccessibilityNodeInfo? {
        var found: AccessibilityNodeInfo? = null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty() && found == null) {
            val node = queue.removeFirst()
            val nodeText = node.text?.toString()
            val nodeDesc = node.contentDescription?.toString()
            val matches = (nodeText?.contains(text) == true) || (nodeDesc?.contains(text) == true)
            if (matches && node.isClickable) {
                found = node
                break
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }
        return found
    }

    /** 无障碍手势：在指定归一化坐标（0..1000）点按。用于 tap_text 的华为端实现。 */
    fun tapCoordinate(x: Int, y: Int): Map<String, Any?> {
        return try {
            val root = rootInActiveWindow ?: return mapOf("ok" to false, "error" to "取不到当前窗口")
            val bounds = Rect()
            root.getBoundsInScreen(bounds)
            if (bounds.isEmpty) return mapOf("ok" to false, "error" to "窗口无有效区域")
            val px = bounds.left + (x.toFloat() / 1000f) * bounds.width()
            val py = bounds.top + (y.toFloat() / 1000f) * bounds.height()
            val path = Path().apply { moveTo(px, py) }
            val gesture = GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
                .build()
            val ok = dispatchGesture(gesture, null, null)
            mapOf("ok" to ok)
        } catch (t: Throwable) {
            mapOf("ok" to false, "error" to (t.message ?: "点按失败"))
        }
    }

    /** 无障碍长按：在归一化坐标（0..1000）按住 500ms，用于长按菜单/复制等。 */
    fun longPressCoordinate(x: Int, y: Int): Map<String, Any?> {
        return try {
            val root = rootInActiveWindow ?: return mapOf("ok" to false, "error" to "取不到当前窗口")
            val bounds = Rect()
            root.getBoundsInScreen(bounds)
            if (bounds.isEmpty) return mapOf("ok" to false, "error" to "窗口无有效区域")
            val px = bounds.left + (x.toFloat() / 1000f) * bounds.width()
            val py = bounds.top + (y.toFloat() / 1000f) * bounds.height()
            val path = Path().apply { moveTo(px, py) }
            val gesture = GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 500))
                .build()
            val ok = dispatchGesture(gesture, null, null)
            mapOf("ok" to ok)
        } catch (t: Throwable) {
            mapOf("ok" to false, "error" to (t.message ?: "长按失败"))
        }
    }

    /** 无障碍滑动：归一化坐标起点到终点，用于翻页/滚动/下拉等。 */
    fun swipeCoordinate(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long = 300): Map<String, Any?> {
        return try {
            val root = rootInActiveWindow ?: return mapOf("ok" to false, "error" to "取不到当前窗口")
            val bounds = Rect()
            root.getBoundsInScreen(bounds)
            if (bounds.isEmpty) return mapOf("ok" to false, "error" to "窗口无有效区域")
            fun mapX(x: Int): Float = bounds.left + (x.toFloat() / 1000f) * bounds.width()
            fun mapY(y: Int): Float = bounds.top + (y.toFloat() / 1000f) * bounds.height()
            val path = Path().apply {
                moveTo(mapX(x1), mapY(y1))
                lineTo(mapX(x2), mapY(y2))
            }
            val gesture = GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
                .build()
            val ok = dispatchGesture(gesture, null, null)
            mapOf("ok" to ok)
        } catch (t: Throwable) {
            mapOf("ok" to false, "error" to (t.message ?: "滑动失败"))
        }
    }

    /** 系统级按键：home/back/recents/通知栏/快捷开关/息屏。 */
    fun pressKey(key: String): Map<String, Any?> {
        val action = when (key) {
            "home" -> GLOBAL_ACTION_HOME
            "back" -> GLOBAL_ACTION_BACK
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "lock_screen" -> GLOBAL_ACTION_LOCK_SCREEN
            else -> return mapOf("ok" to false, "error" to "未知按键 $key")
        }
        return mapOf("ok" to performGlobalAction(action))
    }

    /** 当前前台窗口的应用包名（此刻状态·当前 App）。 */
    fun foregroundApp(): String {
        return runCatching {
            windows?.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
                ?.maxByOrNull { it.layer }?.root?.packageName?.toString()
        }.getOrNull() ?: rootInActiveWindow?.packageName?.toString() ?: ""
    }

    private fun jsonStr(v: String?): String {
        if (v == null) return "null"
        return "\"" + v
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t") + "\""
    }
}
