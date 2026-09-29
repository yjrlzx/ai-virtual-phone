$ErrorActionPreference = "Stop"
$p = "C:\Users\杨静茹\Desktop\ai-virtual-phone-src\lib\tool-executor.ts"
$c = [IO.File]::ReadAllText($p)
$c = $c.Replace("`r`n", "`n")

# 1) isHuaweiShellToolName 加 7 名
$oldN = @'
        || name === "发送提醒"
        || name === "读取微信消息"
        || loadHuaweiCustomActions().some(action => action.enabled && action.name === name);
}
'@
$newN = @'
        || name === "发送提醒"
        || name === "读取微信消息"
        || name === "查看设备详情"
        || name === "调节音量"
        || name === "调节亮度"
        || name === "读取剪贴板"
        || name === "写入剪贴板"
        || name === "打开网页"
        || name === "读取文件"
        || loadHuaweiCustomActions().some(action => action.enabled && action.name === name);
}
'@
if (-not $c.Contains($oldN)) { throw "names anchor MISS" }
$c = $c.Replace($oldN, $newN)
Write-Output "names: OK"

# 2) 7 个执行函数
$oldF = @'
    const openHint = openApp ? `，点击将打开 ${huaweiAppLabel(openApp)}` : "";
    return huaweiToolOk("发送提醒", `已推送提醒「${title}」：${content}${openHint}`);
}
async function executeHuaweiShellTool(call: ToolCall): Promise<ToolResult> {
'@
$newF = @'
    const openHint = openApp ? `，点击将打开 ${huaweiAppLabel(openApp)}` : "";
    return huaweiToolOk("发送提醒", `已推送提醒「${title}」：${content}${openHint}`);
}

function huaweiDeviceInfoTool(): ToolResult {
    const result = invokeShellJson<Record<string, unknown>>(shell => (shell.getDeviceInfo ? shell.getDeviceInfo() : null));
    if (!result.ok) return huaweiToolFail("查看设备详情", result.error);
    const r = result.data;
    const gb = (v: unknown): string => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB` : "未知";
    };
    const parts: string[] = [];
    if (typeof r.model === "string" && r.model) parts.push(`机型 ${r.model}`);
    if (typeof r.androidVersion === "string" && r.androidVersion) parts.push(`系统 Android ${r.androidVersion}`);
    parts.push(`存储 ${gb(r.storageFree)} 可用 / 共 ${gb(r.storageTotal)}`);
    parts.push(`内存 ${gb(r.ramFree)} 可用 / 共 ${gb(r.ramTotal)}`);
    if (typeof r.batteryTempC === "number") parts.push(`电池温度 ${r.batteryTempC.toFixed(1)}℃`);
    if (typeof r.uptimeMs === "number") {
        const upMin = Math.floor(Number(r.uptimeMs) / 60000);
        parts.push(upMin < 60 ? `已运行 ${upMin} 分钟` : `已运行 ${Math.floor(upMin / 60)} 小时 ${upMin % 60} 分`);
    }
    return huaweiToolOk("查看设备详情", parts.length > 0 ? parts.join("，") : "未获取到设备信息");
}

function huaweiVolumeTool(args: Record<string, unknown>): ToolResult {
    const stream = args.stream === "alarm" ? "alarm" : args.stream === "ring" ? "ring" : "media";
    const value = clampToolInteger(args.value, 0, 100, 50);
    const result = invokeShellJson(shell => (shell.setVolume ? shell.setVolume(stream, value) : null));
    if (!result.ok) return huaweiToolFail("调节音量", result.error);
    const streamLabel = stream === "media" ? "媒体" : stream === "alarm" ? "闹钟" : "铃声";
    return huaweiToolOk("调节音量", `已将${streamLabel}音量调到 ${value}`);
}

function huaweiBrightnessTool(args: Record<string, unknown>): ToolResult {
    const value = clampToolInteger(args.value, 0, 100, 50);
    const result = invokeShellJson(shell => (shell.setBrightness ? shell.setBrightness(value) : null));
    if (!result.ok) return huaweiToolFail("调节亮度", result.error);
    return huaweiToolOk("调节亮度", `已将屏幕亮度调到 ${value}%`);
}

function huaweiClipboardReadTool(): ToolResult {
    const result = invokeShellJson<Record<string, unknown>>(shell => (shell.readClipboard ? shell.readClipboard() : null));
    if (!result.ok) return huaweiToolFail("读取剪贴板", result.error);
    const text = String(result.data.text ?? "");
    if (!text) return huaweiToolOk("读取剪贴板", "剪贴板是空的");
    return huaweiToolOk("读取剪贴板", `剪贴板内容：${truncate(text)}`);
}

function huaweiClipboardWriteTool(args: Record<string, unknown>): ToolResult {
    const text = requiredStringArg(args, "text");
    if (!text) return huaweiToolFail("写入剪贴板", "缺少 text 参数（要写入的内容）");
    const result = invokeShellJson(shell => (shell.writeClipboard ? shell.writeClipboard(text) : null));
    if (!result.ok) return huaweiToolFail("写入剪贴板", result.error);
    return huaweiToolOk("写入剪贴板", `已写入剪贴板：${truncate(text)}`);
}

function huaweiOpenUrlTool(args: Record<string, unknown>): ToolResult {
    const url = requiredStringArg(args, "url");
    if (!url) return huaweiToolFail("打开网页", "缺少 url 参数（网页链接）");
    const result = invokeShellJson(shell => (shell.openUrl ? shell.openUrl(url) : null));
    if (!result.ok) return huaweiToolFail("打开网页", result.error);
    return huaweiToolOk("打开网页", `已在{{user}}手机浏览器打开 ${url}`);
}

function huaweiReadFileTool(args: Record<string, unknown>): ToolResult {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    const result = invokeShellJson<Record<string, unknown>>(shell => (shell.readFile ? shell.readFile(path) : null));
    if (!result.ok) return huaweiToolFail("读取文件", result.error);
    const kind = String(result.data.kind ?? "");
    if (kind === "dir") {
        const files = Array.isArray(result.data.files) ? result.data.files as Array<Record<string, unknown>> : [];
        if (files.length === 0) return huaweiToolOk("读取文件", `目录 ${String(result.data.path ?? "")} 是空的`);
        const lines = files.map((f, i) => {
            const size = typeof f.size === "number" ? `（${(f.size / 1024).toFixed(1)} KB）` : "";
            return `${i + 1}. ${f.isDir ? "📁" : "📄"} ${f.name}${size}`;
        });
        return huaweiToolOk("读取文件", `目录 ${String(result.data.path ?? "")}：\n${truncate(lines.join("\n"))}`);
    }
    if (kind === "image") {
        const size = typeof result.data.size === "number" ? `${(Number(result.data.size) / 1024).toFixed(1)} KB` : "未知";
        const dims = typeof result.data.width === "number" && typeof result.data.height === "number"
            ? `，${result.data.width}×${result.data.height}` : "";
        return huaweiToolOk("读取文件", `已读取图片文件 ${String(result.data.path ?? "")}（${size}${dims}），可备份查看`);
    }
    const content = String(result.data.content ?? "");
    if (!content) return huaweiToolOk("读取文件", `文件 ${String(result.data.path ?? "")} 为空`);
    return huaweiToolOk("读取文件", `文件 ${String(result.data.path ?? "")}：\n${truncate(content)}`);
}

async function executeHuaweiShellTool(call: ToolCall): Promise<ToolResult> {
'@
if (-not $c.Contains($oldF)) { throw "fns anchor MISS" }
$c = $c.Replace($oldF, $newF)
Write-Output "fns: OK"

# 3) switch 分支
$oldS = @'
        case "发送提醒": return huaweiSendReminderTool(args);
        case "读取微信消息": return huaweiWeChatMessagesTool(args);
        default: return executeHuaweiCustomAction(call.name, args);
'@
$newS = @'
        case "发送提醒": return huaweiSendReminderTool(args);
        case "读取微信消息": return huaweiWeChatMessagesTool(args);
        case "查看设备详情": return huaweiDeviceInfoTool();
        case "调节音量": return huaweiVolumeTool(args);
        case "调节亮度": return huaweiBrightnessTool(args);
        case "读取剪贴板": return huaweiClipboardReadTool();
        case "写入剪贴板": return huaweiClipboardWriteTool(args);
        case "打开网页": return huaweiOpenUrlTool(args);
        case "读取文件": return huaweiReadFileTool(args);
        default: return executeHuaweiCustomAction(call.name, args);
'@
if (-not $c.Contains($oldS)) { throw "switch anchor MISS" }
$c = $c.Replace($oldS, $newS)
Write-Output "switch: OK"

$c = $c.Replace("`n", "`r`n")
[IO.File]::WriteAllText($p, $c, (New-Object Text.UTF8Encoding $false))
Write-Output "tool-executor done"
