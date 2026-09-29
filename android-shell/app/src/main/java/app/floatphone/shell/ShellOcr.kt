package app.floatphone.shell

import android.content.Context
import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject

/**
 * OCR 记账兜底的识别后端：
 *  - engine=mlkit：本机 ML Kit 文本识别（离线，MlKitOcrHelper）；
 *  - engine=online：截屏 JPEG 上传可配在线 OCR 接口（multipart，解析 text/result/data.text 等多路径）；
 *  - engine=web：不识别，把截屏 JPEG dataUrl 回传网页，交给网页侧视觉/人工处理。
 * 结果统一经 callback(json) 回传给网页（window.__floatBridgeOnOcrResult）。
 */
object ShellOcr {

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    fun recognize(context: Context, bitmap: Bitmap, engine: String, onlineUrl: String, onlineKey: String, cb: (String) -> Unit) {
        when (engine) {
            "mlkit" -> MlKitOcrHelper.recognize(context, bitmap, cb)
            "online" -> recognizeOnline(bitmap, onlineUrl, onlineKey, cb)
            else -> {
                val dataUrl = jpegDataUrl(bitmap, 85)
                cb(JSONObject()
                    .put("ok", true)
                    .put("engine", "web")
                    .put("image", dataUrl)
                    .toString())
            }
        }
    }

    private fun recognizeOnline(bitmap: Bitmap, onlineUrl: String, onlineKey: String, cb: (String) -> Unit) {
        if (onlineUrl.isBlank()) {
            cb("""{"ok":false,"engine":"online","error":"未配置在线 OCR 地址"}""")
            return
        }
        try {
            val jpeg = jpegBytes(bitmap, 85)
            val filePart = jpeg.toRequestBody("image/jpeg".toMediaType())
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", "screen.jpg", filePart)
                .addFormDataPart("language", "chs")
                .build()
            val req = Request.Builder()
                .url(onlineUrl)
                .header("Authorization", "Bearer $onlineKey")
                .post(body)
                .build()
            httpClient.newCall(req).execute().use { resp ->
                val text = resp.body?.string() ?: ""
                val parsed = runCatching { JSONObject(text) }.getOrNull()
                val result = parsed?.optString("text")
                    ?: parsed?.optString("result")
                    ?: parsed?.optString("data")?.let { runCatching { JSONObject(it).optString("text") }.getOrNull() }
                    ?: parsed?.optString("data")?.let { runCatching { JSONObject(it).optString("result") }.getOrNull() }
                if (result.isNullOrBlank()) {
                    cb("""{"ok":false,"engine":"online","error":"在线 OCR 未返回文本（${resp.code}）"}""")
                } else {
                    cb(JSONObject().put("ok", true).put("engine", "online").put("text", result.trim()).toString())
                }
            }
        } catch (e: Exception) {
            cb(JSONObject().put("ok", false).put("engine", "online").put("error", "在线 OCR 失败：${e.message}").toString())
        }
    }

    fun jpegDataUrl(bitmap: Bitmap, quality: Int): String {
        val bytes = jpegBytes(bitmap, quality)
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        return "data:image/jpeg;base64,$b64"
    }

    private fun jpegBytes(bitmap: Bitmap, quality: Int): ByteArray {
        val baos = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, baos)
        return baos.toByteArray()
    }
}