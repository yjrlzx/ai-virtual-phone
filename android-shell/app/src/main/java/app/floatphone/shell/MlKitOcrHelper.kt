package app.floatphone.shell

import android.content.Context
import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import org.json.JSONObject

/**
 * 本机 OCR（ML Kit 文本识别）助手：离线识别屏幕文字，供自动记账兜底与手动识别工具使用。
 * 依赖 com.google.mlkit:text-recognition（gradle 已声明）。识别结果经 callback 回传网页。
 */
object MlKitOcrHelper {

    @Volatile
    private var recognizer: com.google.mlkit.vision.text.TextRecognizer? = null

    private fun client(context: Context): com.google.mlkit.vision.text.TextRecognizer {
        var r = recognizer
        if (r == null) {
            r = TextRecognition.getClient()
            recognizer = r
        }
        return r
    }

    /** 异步识别截图文字。 */
    fun recognize(context: Context, bitmap: Bitmap, cb: (String) -> Unit) {
        val image = InputImage.fromBitmap(bitmap, 0)
        client(context).process(image)
            .addOnSuccessListener { text ->
                cb(JSONObject().put("ok", true).put("engine", "mlkit").put("text", text.text ?: "").toString())
            }
            .addOnFailureListener { e ->
                cb(JSONObject().put("ok", false).put("engine", "mlkit").put("error", "本机识别失败：${e.message}").toString())
            }
    }
}