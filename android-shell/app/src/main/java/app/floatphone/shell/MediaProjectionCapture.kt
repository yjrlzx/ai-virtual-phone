package app.floatphone.shell

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics

/**
 * 现实桥·华为端 MediaProjection 截图器。
 *
 * token 由 MainActivity 的截屏授权结果注入。授权一次后 MediaProjection 实例跨多次截图复用：
 * 单次 capture 只创建/释放 VirtualDisplay，不 stop 投影——因为授权 token 是一次性的，
 * 一旦 projection.stop() 后同一 token 不可再用，悬浮球双击就会用一次就永久失灵。
 *
 * 投影为空或已失效（用户在快捷设置停止录屏 / getMediaProjection 抛错）时：
 * capture 回调 onResult(null) 并把 needsReauth 置 true，由调用方（悬浮球/网页）触发重新授权。
 */
object MediaProjectionCapture {

    @Volatile
    var projectionToken: Intent? = null

    /** 投影为空或已失效时为 true：调用方据此触发重新弹系统授权。 */
    @Volatile
    var needsReauth: Boolean = false
        private set

    /** 一次截图进行中标记：避免连续双击并发创建多个 VirtualDisplay。 */
    @Volatile
    private var busy = false

    private var manager: MediaProjectionManager? = null
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    /** 拉一次截图；失败时 onResult(null)。回调在主线程。 */
    fun capture(context: Context, onResult: (Bitmap?) -> Unit) {
        if (busy) {
            // 上一帧还没拍完，直接返回（这不是授权问题，不要触发重新授权弹窗）
            mainHandler.post { onResult(null) }
            return
        }
        busy = true

        val mp = obtainProjection(context)
        if (mp == null) {
            needsReauth = true
            busy = false
            mainHandler.post { onResult(null) }
            return
        }

        try {
            val metrics: DisplayMetrics = context.resources.displayMetrics
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
            val size = android.graphics.Point()
            wm.defaultDisplay.getRealSize(size)
            val w = size.x
            val h = size.y
            val dpi = metrics.densityDpi
            val r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
            reader = r
            val vd = mp.createVirtualDisplay(
                "reality-bridge-capture", w, h, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, mainHandler,
            )
            virtualDisplay = vd

            r.setOnImageAvailableListener({ imgReader ->
                try {
                    val image = imgReader.acquireLatestImage()
                        ?: run {
                            mainHandler.post { onResult(null) }
                            return@setOnImageAvailableListener
                        }
                    val planes = image.planes
                    val buffer = planes[0].buffer
                    val pixelStride = planes[0].pixelStride
                    val rowStride = planes[0].rowStride
                    val rowPadding = rowStride - pixelStride * w
                    val bitmap = Bitmap.createBitmap(w + rowPadding / pixelStride, h, Bitmap.Config.ARGB_8888)
                    bitmap.copyPixelsFromBuffer(buffer)
                    val cropped = Bitmap.createBitmap(bitmap, 0, 0, w, h)
                    image.close()
                    // 注意：cropped 与 bitmap 共享像素后备，绝不能 recycle(bitmap)，
                    // 否则回传给网页的是已回收位图，compress 会抛异常而静默失败。
                    mainHandler.post { onResult(cropped) }
                } catch (t: Throwable) {
                    mainHandler.post { onResult(null) }
                } finally {
                    releaseFrame()
                }
            }, mainHandler)
        } catch (t: Throwable) {
            // createVirtualDisplay 抛错通常意味着投影已失效，丢弃并要求重新授权
            runCatching { virtualDisplay?.release() }
            virtualDisplay = null
            runCatching { reader?.close() }
            reader = null
            releaseProjectionHard()
            needsReauth = true
            busy = false
            mainHandler.post { onResult(null) }
        }
    }

    /** 取或建 MediaProjection；失败返回 null（此时需重新授权）。成功复用已有投影。 */
    private fun obtainProjection(context: Context): MediaProjection? {
        projection?.let { return it }
        val token = projectionToken ?: return null
        val m = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager ?: return null
        manager = m
        val mp = runCatching { m.getMediaProjection(android.app.Activity.RESULT_OK, token) }.getOrNull()
            ?: return null
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                // 用户在系统快捷设置里停止了录屏：清空一切，下次双击走重新授权
                runCatching { virtualDisplay?.release() }
                virtualDisplay = null
                runCatching { reader?.close() }
                reader = null
                projection = null
                projectionToken = null
                needsReauth = true
                busy = false
            }
        }, mainHandler)
        needsReauth = false
        projection = mp
        return mp
    }

    /** 释放单帧资源（VirtualDisplay + ImageReader），保留 projection 供下次复用。 */
    private fun releaseFrame() {
        runCatching { virtualDisplay?.release() }
        virtualDisplay = null
        runCatching { reader?.close() }
        reader = null
        busy = false
    }

    /** 投影本身失效：彻底丢弃，强制下次重新授权。 */
    private fun releaseProjectionHard() {
        runCatching { projection?.stop() }
        projection = null
        projectionToken = null
    }
}
