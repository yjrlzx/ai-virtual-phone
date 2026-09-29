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

        /** 应用门禁锁定包名集合：命中即强制拦截回桌面。 */
        private val lockedPackages = CopyOnWriteArraySet<String>()
        private var lastEnforced = 0L

        /** 专注模式截止时间戳（ms），在此之前拦截除壳自身外的一切前台 App。 */
        private var focusUntil = 0L

        /** 开启专注模式 durationMin 分钟，期间锁定全机，可随时调用关闭。 */
        fun setFocusMode(durationMin: Int) {
            // 防御性上限：网页侧 clamp 1..240 分钟，原生侧再兜一层，防异常入参把锁定拉到数天；<=0 表示关闭
            val min = durationMin.coerceIn(0, 240)
            focusUntil = if (min > 0) System.currentTimeMillis() + min * 60_000L else 0L
        }

        fun isFocusing(): Boolean = System.currentTimeMillis() < focusUntil

        fun setLockedPackages(pkgs: List<String>) {
            lockedPackages.clear()
            lockedPackages.addAll(pkgs.filter { it.isNotBlank() })
            recheckGate()
        }

        fun addLockedPackage(pkg: String) {
            if (pkg.isNotBlank()) lockedPackages.add(pkg)
            recheckGate()
        }

        /** 锁定后立即检查当前前台是否命中，命中即立刻拦截（补窗口事件兜底）。 */
        fun recheckGate() {
            val svc = current() ?: return
            val pkg = svc.foregroundApp().ifBlank { return }
            svc.maybeEnforceGate(pkg)
        }

        fun removeLockedPackage(pkg: String) {
            lockedPackages.remove(pkg)
        }

        fun getLockedPackages(): List<String> = lockedPackages.toList()

        fun isLockedPackage(pkg: String): Boolean = lockedPackages.contains(pkg)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

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
        val locked = lockedPackages.contains(pkg)
        if (!focusing && !locked) return
        // 专注模式不锁壳自身（否则把现实桥网页也锁掉，无法退出）
        if (focusing && pkg == applicationContext.packageName) return
        if (now - lastEnforced < 1500L) return
        lastEnforced = now
        performGlobalAction(GLOBAL_ACTION_HOME)
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

    /** 返回当前前台窗口的可读节点树 JSON（掌心窗 getScreenNodes 的华为端实现）。 */
    fun dumpScreenTree(limit: Int = 200): String {
        return try {
            val root = rootInActiveWindow ?: return """{"ok":false,"error":"无障碍已开但取不到当前窗口"}"""
            val nodes = ArrayList<Map<String, Any?>>()
            collectNodes(root, nodes, limit)
            val json = StringBuilder().append("[")
            for (i in nodes.indices) {
                if (i > 0) json.append(",")
                val n = nodes[i]
                json.append("{")
                json.append("\"text\":").append(jsonStr(n["text"]?.toString()))
                json.append(",\"desc\":").append(jsonStr(n["desc"]?.toString()))
                json.append(",\"id\":").append(jsonStr(n["id"]?.toString()))
                json.append(",\"class\":").append(jsonStr(n["class"]?.toString()))
                json.append(",\"clickable\":").append(n["clickable"])
                json.append(",\"rect\":").append(jsonStr(n["rect"]?.toString()))
                json.append("}")
            }
            json.append("]").toString()
        } catch (t: Throwable) {
            """{"ok":false,"error":"${jsonStr(t.message)}"}"""
        }
    }

    private fun collectNodes(node: AccessibilityNodeInfo, out: MutableList<Map<String, Any?>>, limit: Int) {
        if (out.size >= limit) return
        val text = node.text?.toString()
        val desc = node.contentDescription?.toString()
        if (!text.isNullOrBlank() || !desc.isNullOrBlank() || node.isClickable) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            out.add(
                mapOf(
                    "text" to text,
                    "desc" to desc,
                    "id" to node.viewIdResourceName,
                    "class" to node.className?.toString(),
                    "clickable" to node.isClickable,
                    "rect" to "$rect",
                ),
            )
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child -> collectNodes(child, out, limit) }
        }
    }

    /** 按可见文字定位第一个可点击节点并触发点击。返回是否找到并点击。 */
    fun clickText(text: String): Map<String, Any?> {
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
