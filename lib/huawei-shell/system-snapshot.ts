/**
 * 现实桥系统状态快照（Operit 式注入）。
 * 壳端 getSystemContextSnapshot() 一次性给：电量/充电/网络/经纬度/前台应用；
 * 网页层负责：按现实桥三项开关过滤、补当前时间、用 Open-Meteo 免费接口补天气。
 * 关闭的项直接不出现在文本里（不返回 null，避免 LLM 困惑）。
 */

import { getAndroidShell, loadHuaweiShellSettings, parseShellJson } from "./storage";

type ShellSnapshot = {
    ok?: boolean;
    batteryLevel?: number;
    isCharging?: boolean;
    networkType?: string;
    location?: { lat?: number; lng?: number } | null;
    foregroundApp?: string;
};

/* ---------- 天气：Open-Meteo（无需 key），10 分钟内存缓存 ---------- */

let weatherCache: { key: string; at: number; text: string } | null = null;

function weatherCodeText(code: number | undefined): string {
    if (code === 0) return "晴";
    if (code === 1 || code === 2) return "大致晴朗";
    if (code === 3) return "多云";
    if (code === 45 || code === 48) return "有雾";
    if (typeof code === "number" && code >= 51 && code <= 67) return "有雨";
    if (typeof code === "number" && code >= 71 && code <= 77) return "有雪";
    if (code === 80 || code === 81 || code === 82) return "阵雨";
    if (code === 85 || code === 86) return "阵雪";
    if (typeof code === "number" && code >= 95) return "雷暴";
    return "未知";
}

/** 按经纬度取天气文本（如 "22℃ 晴"）；失败返回 null。供快照与「实时天气」工具共用。 */
export async function fetchWeatherText(lat: number, lng: number): Promise<string | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    if (weatherCache && weatherCache.key === key && Date.now() - weatherCache.at < 10 * 60 * 1000) {
        return weatherCache.text;
    }
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code&timezone=auto`,
            { signal: ctrl.signal },
        );
        clearTimeout(timer);
        if (!res.ok) return null;
        const data = await res.json() as { current?: { temperature_2m?: number; weather_code?: number } };
        const t = data.current?.temperature_2m;
        const text = `${typeof t === "number" ? Math.round(t) : "?"}℃ ${weatherCodeText(data.current?.weather_code)}`;
        weatherCache = { key, at: Date.now(), text };
        return text;
    } catch {
        return null;
    }
}

/* ---------- 快照文本组装 ---------- */

/** 组装注入 system prompt 的「当前系统状态」段落。无壳时只给当前时间。 */
export async function buildSystemContextSnapshot(): Promise<string> {
    const settings = loadHuaweiShellSettings();
    const lines: string[] = [];
    const now = new Date();
    const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
    lines.push(`时间：${now.getMonth() + 1}月${now.getDate()}日 ${week} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);

    let snap: ShellSnapshot | null = null;
    const shell = getAndroidShell();
    if (shell?.getSystemContextSnapshot) {
        snap = parseShellJson<ShellSnapshot>(shell.getSystemContextSnapshot()) || null;
    }

    // 电量：capBatteryEnabled 关闭则整段不出现
    if (settings.capBatteryEnabled && snap && typeof snap.batteryLevel === "number" && Number.isFinite(snap.batteryLevel)) {
        lines.push(`电量：${Math.round(snap.batteryLevel)}%${snap.isCharging ? "（充电中）" : ""}`);
    }

    // 网络与前台应用不属于三项开关，一直附带
    if (snap?.networkType && snap.networkType !== "none") {
        const netText = snap.networkType === "wifi" ? "Wi-Fi"
            : snap.networkType === "mobile" ? "移动网络"
                : "网络在线";
        lines.push(`网络：${netText}`);
    }

    // 定位：capLocationEnabled 关闭则不出现；天气依赖定位且受 capWeatherEnabled 控制
    const loc = snap?.location;
    const lat = typeof loc?.lat === "number" ? loc.lat : NaN;
    const lng = typeof loc?.lng === "number" ? loc.lng : NaN;
    if (settings.capLocationEnabled && Number.isFinite(lat) && Number.isFinite(lng)) {
        lines.push(`定位：纬度${lat.toFixed(3)} 经度${lng.toFixed(3)}`);
        if (settings.capWeatherEnabled) {
            const weather = await fetchWeatherText(lat, lng);
            if (weather) lines.push(`天气：${weather}`);
        }
    }

    if (snap?.foregroundApp) {
        lines.push(`前台应用：${snap.foregroundApp}`);
    }

    return `【当前系统状态】\n${lines.join("\n")}`;
}
