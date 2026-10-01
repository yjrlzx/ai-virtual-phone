package app.floatphone.shell

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * 应用门禁遮挡页：被锁 App 被打开时全屏盖上来。
 * 显示角色圆形头像、被锁 App 名、char 留言、最迟 X 分钟后自动解开；
 * 「回小手机求情」回主壳界面，「返回桌面」回桌面。
 * 到期自动 finish（onResume 复查）。
 */
class GateBlockActivity : Activity() {

    companion object {
        const val EXTRA_PKG = "pkg"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_EXPIRES_AT = "expiresAt"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var minutesLeftView: TextView? = null
    private var expiresAt = 0L

    private val ticker = object : Runnable {
        override fun run() {
            refreshCountdown()
            mainHandler.postDelayed(this, 30_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pkg = intent.getStringExtra(EXTRA_PKG).orEmpty()
        val message = intent.getStringExtra(EXTRA_MESSAGE).orEmpty()
        expiresAt = intent.getLongExtra(EXTRA_EXPIRES_AT, 0L)

        val appLabel = runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg)

        val root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#15161a"))

        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(64, 120, 64, 64)
        }

        val avatar = ImageView(this).apply {
            val size = (120 * resources.displayMetrics.density).toInt()
            layoutParams = LinearLayout.LayoutParams(size, size)
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#2a2d35"))
            }
            clipToOutline = true
        }
        MascotAvatar.bitmap?.let { avatar.setImageBitmap(it) }
        box.addView(avatar)

        val title = TextView(this).apply {
            text = "已锁住 $appLabel"
            setTextColor(Color.WHITE)
            textSize = 20f
            setPadding(0, 48, 0, 16)
            gravity = Gravity.CENTER
        }
        box.addView(title)

        val msg = TextView(this).apply {
            text = message.ifBlank { "这个 App 现在不能用哦。" }
            setTextColor(Color.parseColor("#c9ccd4"))
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(0, 8, 0, 16)
        }
        box.addView(msg)

        minutesLeftView = TextView(this).apply {
            setTextColor(Color.parseColor("#8f95a3"))
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 48)
        }
        box.addView(minutesLeftView)

        val plea = Button(this).apply {
            text = "回小手机求情"
            setOnClickListener {
                runCatching {
                    startActivity(
                        Intent(this@GateBlockActivity, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                    )
                }
                finish()
            }
        }
        box.addView(plea)

        val home = Button(this).apply {
            text = "返回桌面"
            setOnClickListener {
                runCatching {
                    startActivity(
                        Intent(Intent.ACTION_MAIN).apply {
                            addCategory(Intent.CATEGORY_HOME)
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        },
                    )
                }
                finish()
            }
        }
        val homeParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        homeParams.topMargin = (16 * resources.displayMetrics.density).toInt()
        home.layoutParams = homeParams
        box.addView(home)

        root.addView(box, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ).apply { gravity = Gravity.CENTER })
        setContentView(root)
        refreshCountdown()
    }

    override fun onResume() {
        super.onResume()
        // 到期自动收场
        if (expiresAt in 1..System.currentTimeMillis()) {
            finish()
            return
        }
        mainHandler.post(ticker)
    }

    override fun onPause() {
        super.onPause()
        mainHandler.removeCallbacks(ticker)
    }

    private fun refreshCountdown() {
        val now = System.currentTimeMillis()
        val entry = RealityBridgeAccessibility.getLockEntry(
            intent.getStringExtra(EXTRA_PKG).orEmpty(),
        )
        if (entry == null || entry.expired(now)) {
            runCatching {
                Toast.makeText(this, "已自动解锁", Toast.LENGTH_SHORT).show()
            }
            finish()
            return
        }
        minutesLeftView?.text = if (entry.expiresAt <= 0L) {
            "永久锁定 · 解锁后自动关闭此页"
        } else {
            "最迟约 ${entry.minutesLeft(now)} 分钟后自动解开"
        }
    }
}
