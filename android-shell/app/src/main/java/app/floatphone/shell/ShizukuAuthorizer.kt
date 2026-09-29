package app.floatphone.shell

import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import rikka.shizuku.Shizuku

/**
 * Shizuku 授权工具：检查 Shizuku 服务状态、请求权限、执行 shell 命令。
 * 移植自 Operit 的 ShizukuAuthorizer，适配 float 壳环境。
 *
 * Shizuku 提供 shell 权限（UID 2000），不需要 root，通过 ADB 启动即可。
 * 权限级别：DEBUGGER（比 ACCESSIBILITY 更高，可以执行任意 shell 命令）。
 */
object ShizukuAuthorizer {
    private const val TAG = "ShizukuAuthorizer"
    private const val SHIZUKU_PACKAGE_NAME = "moe.shizuku.privileged.api"
    private const val REQUEST_CODE = 100

    private var isServiceAvailable = false
    private var lastServiceErrorMessage = ""
    private var lastPermissionErrorMessage = ""
    private val mainHandler = Handler(Looper.getMainLooper())

    /** 检查 Shizuku 是否已安装（兼容 Sui 后端） */
    fun isShizukuInstalled(context: Context): Boolean {
        return try {
            context.packageManager.getPackageInfo(SHIZUKU_PACKAGE_NAME, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            // 没装 Shizuku 应用，但可能有 Sui 后端
            pingBinder()
        }
    }

    /** 检查 Shizuku 服务是否运行 */
    fun isServiceRunning(): Boolean {
        return try {
            Shizuku.pingBinder()
        } catch (e: Exception) {
            lastServiceErrorMessage = "Shizuku ping failed: ${e.message}"
            false
        }
    }

    /** 检查是否有 Shizuku 权限 */
    fun hasPermission(): Boolean {
        return try {
            if (!isServiceRunning()) {
                lastPermissionErrorMessage = "Shizuku service not running"
                return false
            }
            val result = Shizuku.checkSelfPermission()
            result == PackageManager.PERMISSION_GRANTED
        } catch (e: Exception) {
            lastPermissionErrorMessage = "Error checking permission: ${e.message}"
            false
        }
    }

    /** 请求 Shizuku 权限 */
    fun requestPermission(onResult: (Boolean) -> Unit) {
        if (!isServiceRunning()) {
            onResult(false)
            return
        }
        if (hasPermission()) {
            onResult(true)
            return
        }
        try {
            Shizuku.addRequestPermissionResultListener { code, grantResult ->
                if (code == REQUEST_CODE) {
                    val granted = grantResult == PackageManager.PERMISSION_GRANTED
                    onResult(granted)
                }
            }
            Shizuku.requestPermission(REQUEST_CODE)
        } catch (e: Exception) {
            onResult(false)
        }
    }

    /** 通过 Shizuku 执行 shell 命令，返回 stdout */
    fun executeShell(command: String): ShellCommandResult {
        return try {
            if (!hasPermission()) {
                return ShellCommandResult(false, "", "Shizuku permission not granted", -1)
            }
            val process = Shizuku.newProcess(arrayOf("sh", "-c", command), null, null)
            val stdout = process.inputStream.bufferedReader().readText()
            val stderr = process.errorStream.bufferedReader().readText()
            val exitCode = process.waitFor()
            ShellCommandResult(
                success = exitCode == 0,
                stdout = stdout,
                stderr = stderr,
                exitCode = exitCode
            )
        } catch (e: Exception) {
            ShellCommandResult(false, "", e.message ?: "Unknown error", -1)
        }
    }

    data class ShellCommandResult(
        val success: Boolean,
        val stdout: String,
        val stderr: String,
        val exitCode: Int
    )
}
