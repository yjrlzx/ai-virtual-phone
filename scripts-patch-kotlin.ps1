$ErrorActionPreference = "Stop"
$p = "C:\Users\杨静茹\Desktop\ai-virtual-phone-src\android-shell\app\src\main\java\app\floatphone\shell\MainActivity.kt"
$c = [IO.File]::ReadAllText($p)
$c = $c.Replace("`r`n", "`n")

$oldA = @'
        /** 查询是否处于专注模式。 */
        @JavascriptInterface
        fun isFocusing(): Boolean = RealityBridgeAccessibility.isFocusing()
    }
}
'@
$newA = @'
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
            val bm = getSystemService(BATTERY_SERVICE) as android.os.BatteryManager
            val tempTenths = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_TEMPERATURE)
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
                .put("batteryTempC", tempTenths / 10.0)
                .put("uptimeMs", android.os.SystemClock.uptimeMillis())
                .toString()
        }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }

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
        }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }

        /** 调节屏幕亮度：value 0-100（百分比）自动换算 0-255 写入系统设置。 */
        @JavascriptInterface
        fun setBrightness(value: Int): String = runCatching {
            if (!Settings.System.canWrite(this@MainActivity)) {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
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
        }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }

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
        }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }

        /** 写入剪贴板文本。 */
        @JavascriptInterface
        fun writeClipboard(text: String): String = runCatching {
            val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            cm.setPrimaryClip(android.content.ClipData.newPlainText("角色剪贴板", text))
            """{"ok":true}"""
        }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }

        /** 用系统浏览器打开网页（仅 http/https）。 */
        @JavascriptInterface
        fun openUrl(url: String): String = runCatching {
            val uri = Uri.parse(url.trim())
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return """{"ok":false,"error":"只支持 http/https 链接"}"""
            startActivity(
                Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            """{"ok":true}"""
        }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }

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
        }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }

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
        }.getOrElse { """{"ok":false,"error":"${it.message}"}""" }
    }
}
'@
if (-not $c.Contains($oldA)) { throw "kotlin anchor MISS" }
$c = $c.Replace($oldA, $newA)
$c = $c.Replace("`n", "`r`n")
[IO.File]::WriteAllText($p, $c, (New-Object Text.UTF8Encoding $false))
Write-Output "kotlin done"
