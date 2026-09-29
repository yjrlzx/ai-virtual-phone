package app.floatphone.shell

import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject

/**
 * 穿戴健康快照读取（Gadgetbridge 导出的 SQLite 数据库）：
 * 从各品牌共存的活动/睡眠表中探测有数据的表，读取今日步数、最新心率、压力、活动千卡、最近睡眠。
 * 华为/小米等品牌通用；导出路径与开关由设置页配置，代码不写死任何品牌/路径。
 */
object ShellHealth {

    /** 读取 Gadgetbridge 导出库快照。仅支持 SQLite 库；JSON 快照由网页侧 readFile 读取解析。 */
    fun readSnapshot(exportPath: String): String {
        val path = String(exportPath ?: "").trim()
        if (path.isEmpty()) return """{"ok":false,"status":"disabled","message":"未配置手环导出路径"}"""
        if (!android.os.Environment.getExternalStorageDirectory().exists() && !java.io.File(path).exists()) {
            return """{"ok":false,"status":"missing","message":"未找到导出文件：$path"}"""
        }
        var db: SQLiteDatabase? = null
        return try {
            val file = java.io.File(path)
            if (!file.exists() || !file.isFile()) return """{"ok":false,"status":"missing","message":"未找到导出文件：$path"}"""
            db = SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READONLY)
            val schema = inspectSchema(db)
            val stepsToday = readTodaySum(db, schema, "steps", arrayOf("STEPS", "STEP_COUNT", "STEPCOUNT", "steps", "step_count"))
            val heart = readLatest(db, schema, "heart", arrayOf("HEART_RATE", "HEARTRATE", "HEART_RATE_BPM", "BPM", "heart_rate", "heartrate", "bpm"), 20, 250)
            val stress = readLatest(db, schema, "stress", arrayOf("STRESS", "STRESS_LEVEL", "STRESSLEVEL", "stress", "stress_level"), 1, 100)
            val calories = readTodaySum(db, schema, "calories", arrayOf("ACTIVE_CALORIES", "ACTIVECALORIES", "CALORIES", "active_calories", "activecalories", "calories"))
            val sleep = readSleep(db, schema)
            val supported = stepsToday != null || heart != null || stress != null || calories != null || sleep != null
            JSONObject()
                .put("ok", true)
                .put("status", if (supported) "ready" else "unsupported_schema")
                .put("statusLabel", if (supported) "手环已连接" else "已读取导出文件")
                .put("stepsToday", stepsToday ?: JSONObject.NULL)
                .put("latestHeartRate", heart?.get("value") ?: JSONObject.NULL)
                .put("latestHeartRateAt", heart?.getLong("at") ?: 0L)
                .put("latestStress", stress?.get("value") ?: JSONObject.NULL)
                .put("latestStressAt", stress?.getLong("at") ?: 0L)
                .put("activeCaloriesToday", calories ?: JSONObject.NULL)
                .put("sleepMinutes", sleep?.get("minutes") ?: JSONObject.NULL)
                .put("sleepStartedAt", sleep?.getLong("startedAt") ?: 0L)
                .put("sleepWakeAt", sleep?.getLong("wokeAt") ?: 0L)
                .put("message", if (supported) "健康快照已更新" else "暂未识别到受支持的健康指标")
                .toString()
        } catch (e: Exception) {
            """{"ok":false,"status":"error","message":"导出文件无法读取：${e.message}"}"""
        } finally {
            runCatching { db?.close() }
        }
    }

    private fun inspectSchema(db: SQLiteDatabase): List<Pair<String, List<String>>> {
        val out = ArrayList<Pair<String, List<String>>>()
        val cur = db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", null)
        while (cur.moveToNext()) {
            val name = cur.getString(0) ?: continue
            val cols = ArrayList<String>()
            val pc = db.rawQuery("PRAGMA table_info($name)", null)
            while (pc.moveToNext()) cols.add(pc.getString(1) ?: "")
            pc.close()
            out.add(name to cols)
        }
        cur.close()
        return out
    }

    private fun findTable(schema: List<Pair<String, List<String>>>, preferred: Array<String>): Pair<String, List<String>>? {
        val wanted = preferred.map { it.lowercase() }
        for (entry in schema) {
            val (table, cols) = entry
            val candidates = cols.filter { c -> wanted.contains(c.lowercase()) }
            if (candidates.isNotEmpty()) return entry
        }
        return null
    }

    private fun findTableByPrefix(schema: List<Pair<String, List<String>>>, prefixes: Array<String>): Pair<String, List<String>>? {
        for (entry in schema) {
            val (table, _) = entry
            val upper = table.uppercase()
            if (prefixes.any { upper.startsWith(it) }) return entry
        }
        return null
    }

    private fun todayThreshold(db: SQLiteDatabase, table: String, timeCol: String): Long {
        val cur = db.rawQuery("SELECT MAX(CAST($timeCol AS INTEGER)) FROM $table", null)
        var latest = 0L
        if (cur.moveToNext()) latest = cur.getLong(0)
        cur.close()
        val nowMs = System.currentTimeMillis()
        return if (latest >= 100000000000L) nowMs - nowMs % 86400000L else (nowMs / 1000L) - (nowMs / 1000L) % 86400L
    }

    private fun readTodaySum(db: SQLiteDatabase, schema: List<Pair<String, List<String>>>, kind: String, valueCols: Array<String>): Long? {
        val entry = findTable(schema, valueCols) ?: return null
        val (table, cols) = entry
        val valueCol = cols.first { c -> valueCols.any { v -> c.equals(v, ignoreCase = true) } }
        val timeCol = cols.firstOrNull { c -> c.equals("TIMESTAMP", true) || c.equals("TIME", true) || c.equals("DATE", true) || c.equals("START_TIME", true) || c.equals("STARTTIME", true) } ?: return null
        val th = todayThreshold(db, table, timeCol)
        val cur = db.rawQuery(
            "SELECT COALESCE(SUM(CASE WHEN CAST($valueCol AS INTEGER) > 0 THEN CAST($valueCol AS INTEGER) ELSE 0 END),0) AS total, COUNT(*) AS n FROM $table WHERE CAST($timeCol AS INTEGER) >= $th",
            null,
        )
        var total = -1L
        var rows = 0L
        if (cur.moveToNext()) {
            total = cur.getLong(0)
            rows = cur.getLong(1)
        }
        cur.close()
        if (rows <= 0) return null
        // 华为活动千卡为卡（cal），换算成千卡
        var value = if (total > 0) total else 0L
        if (kind == "calories" && table.uppercase().contains("HUAWEI")) value /= 1000
        if (value > 8000 && kind == "calories") return null
        return value
    }

    private fun readLatest(db: SQLiteDatabase, schema: List<Pair<String, List<String>>>, kind: String, valueCols: Array<String>, min: Int, max: Int): JSONObject? {
        val entry = findTable(schema, valueCols) ?: return null
        val (table, cols) = entry
        val valueCol = cols.first { c -> valueCols.any { v -> c.equals(v, ignoreCase = true) } }
        val timeCol = cols.firstOrNull { c -> c.equals("TIMESTAMP", true) || c.equals("TIME", true) || c.equals("DATE", true) || c.equals("START_TIME", true) || c.equals("STARTTIME", true) } ?: return null
        val cur = db.rawQuery(
            "SELECT $valueCol AS value, $timeCol AS at FROM $table WHERE CAST($valueCol AS INTEGER) BETWEEN $min AND $max ORDER BY CAST($timeCol AS INTEGER) DESC LIMIT 1",
            null,
        )
        var result: JSONObject? = null
        if (cur.moveToNext()) {
            val v = cur.getLong(0)
            val atRaw = cur.getLong(1)
            val atMs = if (atRaw < 100000000000L) atRaw * 1000 else atRaw
            result = JSONObject().put("value", v).put("at", atMs)
        }
        cur.close()
        return result
    }

    private fun readSleep(db: SQLiteDatabase, schema: List<Pair<String, List<String>>>): JSONObject? {
        // 小米：XIAOMI_SLEEP_TIME_SAMPLE (TIMESTAMP, TOTAL_DURATION)；华为：HUAWEI_SLEEP_STATS_SAMPLE (BED_TIME, WAKE_UP_TIME)
        val xiaomi = findTableByPrefix(schema, arrayOf("XIAOMI_SLEEP_TIME_SAMPLE"))
        if (xiaomi != null) {
            val (table, cols) = xiaomi
            val timeCol = cols.firstOrNull { it.equals("TIMESTAMP", true) } ?: return null
            val totalCol = cols.firstOrNull { it.equals("TOTAL_DURATION", true) || it.equals("DURATION", true) }
            if (totalCol == null) return null
            val cur = db.rawQuery(
                "SELECT $timeCol AS at, $totalCol AS total FROM $table WHERE CAST($timeCol AS INTEGER) > 0 AND CAST($totalCol AS INTEGER) > 0 ORDER BY CAST($timeCol AS INTEGER) DESC LIMIT 1",
                null,
            )
            var result: JSONObject? = null
            if (cur.moveToNext()) {
                val atRaw = cur.getLong(0)
                val minutes = cur.getLong(1)
                val atMs = if (atRaw < 100000000000L) atRaw * 1000 else atRaw
                result = JSONObject().put("minutes", minutes).put("startedAt", atMs).put("wokeAt", atMs + minutes * 60000L)
            }
            cur.close()
            if (result != null) return result
        }
        val huawei = findTableByPrefix(schema, arrayOf("HUAWEI_SLEEP_STATS_SAMPLE"))
        if (huawei != null) {
            val (table, cols) = huawei
            val bedCol = cols.firstOrNull { it.equals("BED_TIME", true) || it.equals("BEDTIME", true) } ?: return null
            val wakeCol = cols.firstOrNull { it.equals("WAKE_UP_TIME", true) || it.equals("WAKEUP_TIME", true) || it.equals("RISING_TIME", true) }
            val cur = db.rawQuery(
                "SELECT $bedCol AS bed, ${wakeCol ?: "NULL"} AS wake FROM $table WHERE CAST($bedCol AS INTEGER) > 0 ORDER BY CAST($bedCol AS INTEGER) DESC LIMIT 1",
                null,
            )
            var result: JSONObject? = null
            if (cur.moveToNext()) {
                val bedRaw = cur.getLong(0)
                val wakeRaw = if (wakeCol != null) cur.getLong(1) else 0L
                val bedMs = if (bedRaw < 100000000000L) bedRaw * 1000 else bedRaw
                var wakeMs = if (wakeRaw > 0) (if (wakeRaw < 100000000000L) wakeRaw * 1000 else wakeRaw) else 0L
                if (wakeMs <= bedMs) wakeMs = 0L
                val minutes = if (wakeMs > bedMs) (wakeMs - bedMs) / 60000L else null
                result = JSONObject().put("minutes", minutes ?: JSONObject.NULL).put("startedAt", bedMs).put("wokeAt", wakeMs)
            }
            cur.close()
            if (result != null) return result
        }
        return null
    }
}