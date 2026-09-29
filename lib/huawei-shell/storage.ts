"use client";

/** 华为壳数据层：设置存储（kv-db）+ window.AndroidShell 安全调用辅助。
 *  与 iOS 现实桥并行，走同一套本地 kv 存储，不依赖 Supabase / iPhone 快捷指令。 */

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type { HuaweiCustomAction, HuaweiHealthSnapshot, HuaweiOcrEngine, HuaweiPlace, HuaweiShellBridge, HuaweiStatusKey, HuaweiSttMode, HuaweiTriggerRule, HuaweiFootprintEntry, HuaweiWakeWordAction, HuaweiWakeWordMode, HuaweiWhereaboutsPrivacy, HuaweiHealthSource, PaymentSource, ShellJsonResult } from "./types";
export type { HuaweiHealthSnapshot, HuaweiPlace, HuaweiFootprintEntry } from "./types";
import { ALIPAY_PACKAGE, WECHAT_PACKAGE } from "./types";
import { getInstalledCustomApp, readCustomAppCollection, writeCustomAppCollection } from "../custom-app-storage";

const HUAWEI_SHELL_SETTINGS_KEY = "ai_phone_huawei_shell_settings_v1";
registerKvMigration(HUAWEI_SHELL_SETTINGS_KEY);

/** 华为记账账本：自动记账（通知解析）写入「记账应用」同一存储（collection ledger / key records），
 *  查看记账也从这里读 —— 角色工具与记账应用共用一份数据，不存在两个记账入口。 */

const HUAWEI_LEDGER_FALLBACK_KEY = "ai_phone_huawei_ledger_v1";
registerKvMigration(HUAWEI_LEDGER_FALLBACK_KEY);

/** 记账应用（packages/ledger，manifest id=ledger）的宿主存储契约 */
const LEDGER_APP_ID = "ledger";
const LEDGER_COLLECTION = "ledger";
const LEDGER_RECORDS_KEY = "records";

/** 与记账应用一致的账本记录结构（应用只读它认识的字段；ts 为本端补充，便于排序与时间显示） */
export type HuaweiLedgerRecord = {
    id: string;
    date: string;          // YYYY-MM-DD
    type: "expense";
    amount: number;
    category: string;
    note: string;
    merchant: string;
    source: "wechat" | "alipay" | "cash" | "manual";
    auto: true;
    ts?: number;
};

/** 记账应用是否已安装（未装时降级到本地同构存储，装好后自动并入） */
function ledgerAppInstalled(): boolean {
    if (typeof window === "undefined") return false;
    try { return getInstalledCustomApp(LEDGER_APP_ID) !== null; } catch { return false; }
}

function normalizeLedgerRecords(raw: unknown[]): HuaweiLedgerRecord[] {
    return (raw.filter((item): item is HuaweiLedgerRecord => {
        if (!item || typeof item !== "object") return false;
        const r = item as Record<string, unknown>;
        return typeof r.id === "string" && Number.isFinite(Number(r.amount));
    }) as HuaweiLedgerRecord[]).slice(0, 5000);
}

/** 读 records（行 {id:'records', value:'<json数组>'}）；未装应用时读本地降级存储。 */
function loadLedgerRecords(): HuaweiLedgerRecord[] {
    try {
        if (ledgerAppInstalled()) {
            const rows = readCustomAppCollection(LEDGER_APP_ID, LEDGER_COLLECTION);
            const row = rows.find(r => r.id === LEDGER_RECORDS_KEY);
            if (row && typeof row.value === "string") {
                const parsed = JSON.parse(row.value) as unknown;
                if (Array.isArray(parsed)) return normalizeLedgerRecords(parsed);
            }
            return [];
        }
        const raw = kvGet(HUAWEI_LEDGER_FALLBACK_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? normalizeLedgerRecords(parsed) : [];
    } catch {
        return [];
    }
}

/** 写 records：优先记账应用（保留 config 等其它行），否则本地降级存储。 */
function saveLedgerRecords(records: HuaweiLedgerRecord[]): void {
    if (ledgerAppInstalled()) {
        const rows = readCustomAppCollection(LEDGER_APP_ID, LEDGER_COLLECTION);
        const others = rows.filter(r => r.id !== LEDGER_RECORDS_KEY);
        writeCustomAppCollection(LEDGER_APP_ID, LEDGER_COLLECTION, [...others, { id: LEDGER_RECORDS_KEY, value: JSON.stringify(records) }]);
        return;
    }
    kvSet(HUAWEI_LEDGER_FALLBACK_KEY, JSON.stringify(records));
}

function ledgerDedupKey(entry: HuaweiLedgerRecord): string {
    return `${entry.source}|${entry.amount}|${entry.merchant}|${entry.date}`;
}

/** 降级存储 → 记账应用 的一次性并入（应用新装后不丢历史账）。 */
function migrateFallbackLedgerIfNeeded(): void {
    if (!ledgerAppInstalled()) return;
    try {
        const raw = kvGet(HUAWEI_LEDGER_FALLBACK_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return;
        const fallback = normalizeLedgerRecords(parsed);
        if (fallback.length === 0) return;
        const current = loadLedgerRecords();
        const seen = new Set(current.map(ledgerDedupKey));
        const merged = [...current];
        for (const entry of fallback) {
            const key = ledgerDedupKey(entry);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(entry);
        }
        merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        saveLedgerRecords(merged.slice(0, 5000));
        kvSet(HUAWEI_LEDGER_FALLBACK_KEY, "");
    } catch { /* 迁移失败保持降级存储，下次再试 */ }
}

/** 一条壳侧支付通知 → 记账应用格式的记录；解析不了返回 null。 */
function paymentToLedgerRecord(item: Record<string, unknown>): HuaweiLedgerRecord | null {
    const rawAmount = String(item.amount ?? "").trim();
    if (!rawAmount) return null;
    const amount = Number(rawAmount.replace(/[¥￥元\s]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const pkg = String(item.pkg ?? "").trim();
    const merchant = String(item.merchant ?? "").trim();
    const note = String(item.title ?? "").trim();
    const tsNum = (() => { const t = Number(item.ts); return Number.isFinite(t) && t > 0 ? t : Date.now(); })();
    const d = new Date(tsNum);
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const source: HuaweiLedgerRecord["source"] = pkg === WECHAT_PACKAGE ? "wechat" : pkg === ALIPAY_PACKAGE ? "alipay" : "manual";
    return {
        id: `auto_${tsNum}_${Math.random().toString(36).slice(2, 8)}`,
        date, type: "expense", amount, category: "其他",
        note, merchant, source, auto: true, ts: tsNum,
    };
}

/**
 * 自动记账落账：从壳拉取最近支付通知，解析成与记账应用一致的记录，去重写入同一存储。
 * 幂等：同一笔（来源+金额+收款方+日期）只记一次。返回本次新增笔数与账本总数。
 */
export function syncHuaweiLedgerFromShell(limit = 30): { ok: boolean; added: number; total: number; error?: string } {
    migrateFallbackLedgerIfNeeded();
    const shell = getAndroidShell();
    if (!shell || typeof shell.getPayments !== "function") {
        return { ok: false, added: 0, total: loadLedgerRecords().length, error: "华为壳未连接" };
    }
    let raw: string | null = null;
    try {
        raw = shell.getPayments(limit);
    } catch (err) {
        return { ok: false, added: 0, total: loadLedgerRecords().length, error: err instanceof Error ? err.message : String(err) };
    }
    const list = parseShellJson<Array<Record<string, unknown>>>(raw);
    if (!Array.isArray(list)) {
        return { ok: false, added: 0, total: loadLedgerRecords().length, error: "壳返回了无法解析的支付记录" };
    }
    const current = loadLedgerRecords();
    const seen = new Set(current.map(ledgerDedupKey));
    const merged = [...current];
    let added = 0;
    for (const item of list) {
        const entry = paymentToLedgerRecord(item);
        if (!entry) continue;
        const key = ledgerDedupKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
        added++;
    }
    if (added > 0) {
        merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        saveLedgerRecords(merged.slice(0, 5000));
    }
    return { ok: true, added, total: merged.length };
}

/** 从账本读最近记录（可按来源筛选，微信/支付宝分账）。 */
export function readHuaweiLedger(limit: number, source: PaymentSource): HuaweiLedgerRecord[] {
    const all = loadLedgerRecords();
    const filtered = all.filter(entry => {
        if (source === "wechat") return entry.source === "wechat";
        if (source === "alipay") return entry.source === "alipay";
        return true;
    });
    filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return filtered.slice(0, limit);
}

/** 账本摘要（设置页展示）：总笔数 + 微信/支付宝笔数 + 最近同步时间。 */
export function getHuaweiLedgerSummary(): { total: number; wechat: number; alipay: number; other: number; updatedAt: number } {
    const all = loadLedgerRecords();
    const summary = { total: all.length, wechat: 0, alipay: 0, other: 0, updatedAt: 0 };
    for (const entry of all) {
        if (entry.source === "wechat") summary.wechat++;
        else if (entry.source === "alipay") summary.alipay++;
        else summary.other++;
        if (entry.ts && entry.ts > summary.updatedAt) summary.updatedAt = entry.ts;
    }
    return summary;
}
export const DEFAULT_WEATHER_FORECAST_URL =
    "https://api.open-meteo.com/v1/forecast"
    + "?latitude={lat}&longitude={lng}"
    + "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m"
    + "&timezone=auto&forecast_days=1";

export const DEFAULT_WEATHER_REVERSE_URL =
    "https://geocoding-api.open-meteo.com/v1/reverse"
    + "?latitude={lat}&longitude={lng}&language=zh&format=json";

export const PAYMENT_SOURCE_OPTIONS: Array<{ value: PaymentSource; label: string }> = [
    { value: "all", label: "全部" },
    { value: "wechat", label: "微信" },
    { value: "alipay", label: "支付宝" },
];

export type HuaweiShellSettings = {
    /** 天气接口地址模板，支持 {lat} {lng} {key} 占位符 */
    weatherForecastUrl: string;
    /** 逆地理（坐标→城市名）接口地址模板，支持 {lat} {lng} {key} 占位符 */
    weatherReverseUrl: string;
    /** 可选天气服务 Key；填入后替换地址里的 {key} 占位符 */
    weatherApiKey: string;
    /** 专注模式默认时长（分钟） */
    focusDefaultMinutes: number;
    /** 定时息屏默认秒数 */
    screenBreakDefaultSeconds: number;
    /** 门禁锁 App 包名列表（com.android.settings 为系统内置，仅作示例不自动添加） */
    lockedPackages: string[];
    /** 查看通知默认条数 */
    notificationDefaultLimit: number;
    /** 查看记账默认条数 */
    paymentDefaultLimit: number;
    /** 查看记账默认来源筛选 */
    paymentDefaultSource: PaymentSource;
    /** 用户登记的自定义快捷动作（登记后自动生成 char 工具） */
    customActions: HuaweiCustomAction[];
    /** 自动联动规则（通知 / 定时触发动作） */
    triggerRules: HuaweiTriggerRule[];
    /** 联动规则检查间隔（秒），10-300，默认 30 */
    ruleCheckIntervalSec: number;

    /* ---------- 权限层级（照搬 Operit 五级体系，逐级可配） ---------- */
    permissionLevels: {
        standard: boolean;
        accessibility: boolean;
        debugger: boolean;
        admin: boolean;
        root: boolean;
    };
    /** root 检测/执行用的 su 命令（鸿蒙难拿：能开则开，可填自定义 su 路径） */
    rootSuCommand: string;

    /* ---------- 语音能力 ---------- */
    voiceEnabled: boolean;
    sttMode: HuaweiSttMode;
    sttOnlineUrl: string;
    sttOnlineKey: string;
    sttOnlineModel: string;
    wakeWordEnabled: boolean;
    wakeWordText: string;
    wakeWordMode: HuaweiWakeWordMode;
    wakeWordAction: HuaweiWakeWordAction;
    callRingEnabled: boolean;
    callRingTimeoutSec: number;

    /* ---------- OCR 记账兜底 ---------- */
    ocrEnabled: boolean;
    ocrEngine: HuaweiOcrEngine;
    ocrOnlineUrl: string;
    ocrOnlineKey: string;
    ocrScanPackages: string[];
    ocrResultKeywords: string[];
    ocrAmountRegex: string;
    ocrConfirmRequired: boolean;
    ocrDedupeWindowMin: number;
    ocrScanIntervalSec: number;

    /* ---------- 语义行踪与足迹 ---------- */
    whereaboutsEnabled: boolean;
    whereaboutsPrivacyMode: HuaweiWhereaboutsPrivacy;
    whereaboutsHomeLat: number | null;
    whereaboutsHomeLng: number | null;
    whereaboutsPlaces: HuaweiPlace[];
    whereaboutsGeofenceRadiusM: number;
    whereaboutsExitHysteresisM: number;
    whereaboutsRetentionDays: number;
    whereaboutsScanIntervalSec: number;

    /* ---------- 穿戴健康 ---------- */
    healthEnabled: boolean;
    healthSource: HuaweiHealthSource;
    healthExportPath: string;
    healthRefreshIntervalSec: number;

    /* ---------- 陪伴推送强化 ---------- */
    companionEnabled: boolean;
    companionLocationArrived: boolean;
    companionLocationLeft: boolean;
    companionLocationPlace: boolean;
    companionLowBattery: boolean;
    companionLowBatteryThreshold: number;
    companionSleepShort: boolean;
    companionSleepThresholdMinutes: number;
    companionSevereWeather: boolean;
    companionWeatherCodeMin: number;
    companionWeatherPattern: string;
    companionTitle: string;
    companionTemplates: {
        arrivedHome: string;
        leftHome: string;
        atPlace: string;
        lowBattery: string;
        sleepShort: string;
        severeWeather: string;
    };
    companionLatched: {
        lastArrivedDate: string;
        lastLeftDate: string;
        lastPlaceDate: string;
        lastLowBatteryLevel: number | null;
        lastSleepDate: string;
        lastWeatherAlert: string;
    };
};

const DEFAULT_SETTINGS: HuaweiShellSettings = {
    weatherForecastUrl: DEFAULT_WEATHER_FORECAST_URL,
    weatherReverseUrl: DEFAULT_WEATHER_REVERSE_URL,
    weatherApiKey: "",
    focusDefaultMinutes: 25,
    screenBreakDefaultSeconds: 60,
    lockedPackages: [],
    notificationDefaultLimit: 10,
    paymentDefaultLimit: 20,
    paymentDefaultSource: "all",
    customActions: [],
    triggerRules: [],
    ruleCheckIntervalSec: 30,

    permissionLevels: { standard: true, accessibility: true, debugger: false, admin: false, root: false },
    rootSuCommand: "su",

    voiceEnabled: true,
    sttMode: "system",
    sttOnlineUrl: "",
    sttOnlineKey: "",
    sttOnlineModel: "whisper-1",
    wakeWordEnabled: false,
    wakeWordText: "小浮小浮",
    wakeWordMode: "system",
    wakeWordAction: "floating",
    callRingEnabled: true,
    callRingTimeoutSec: 30,

    ocrEnabled: false,
    ocrEngine: "mlkit",
    ocrOnlineUrl: "",
    ocrOnlineKey: "",
    ocrScanPackages: ["com.tencent.mm", "com.eg.android.AlipayGphone", "com.huawei.hwpay", "com.huawei.hmos.pay"],
    ocrResultKeywords: ["支付成功", "付款成功", "交易成功", "支付完成"],
    ocrAmountRegex: "([¥￥]\\s*\\d+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?\\s*元)",
    ocrConfirmRequired: true,
    ocrDedupeWindowMin: 10,
    ocrScanIntervalSec: 15,

    whereaboutsEnabled: true,
    whereaboutsPrivacyMode: "semantic",
    whereaboutsHomeLat: null,
    whereaboutsHomeLng: null,
    whereaboutsPlaces: [],
    whereaboutsGeofenceRadiusM: 150,
    whereaboutsExitHysteresisM: 60,
    whereaboutsRetentionDays: 30,
    whereaboutsScanIntervalSec: 300,

    healthEnabled: false,
    healthSource: "gadgetbridge_sqlite",
    healthExportPath: "",
    healthRefreshIntervalSec: 600,

    companionEnabled: false,
    companionLocationArrived: true,
    companionLocationLeft: true,
    companionLocationPlace: true,
    companionLowBattery: true,
    companionLowBatteryThreshold: 20,
    companionSleepShort: true,
    companionSleepThresholdMinutes: 420,
    companionSevereWeather: true,
    companionWeatherCodeMin: 60,
    companionWeatherPattern: "雨|雪|雷|暴",
    companionTitle: "小浮",
    companionTemplates: {
        arrivedHome: "你到家啦，辛苦啦。",
        leftHome: "你出门啦，路上注意安全。",
        atPlace: "你到「{place}」了。",
        lowBattery: "手机快没电了（剩 {level}%），记得充电。",
        sleepShort: "昨晚只睡了 {minutes}，记得补觉。",
        severeWeather: "{condition}，出门注意安全。",
    },
    companionLatched: {
        lastArrivedDate: "",
        lastLeftDate: "",
        lastPlaceDate: "",
        lastLowBatteryLevel: null,
        lastSleepDate: "",
        lastWeatherAlert: "",
    },
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function loadHuaweiShellSettings(): HuaweiShellSettings {
    try {
        const raw = kvGet(HUAWEI_SHELL_SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        const parsed = JSON.parse(raw) as Partial<HuaweiShellSettings>;
        const source = parsed.paymentDefaultSource === "wechat" || parsed.paymentDefaultSource === "alipay"
            ? parsed.paymentDefaultSource
            : "all";
        const packages = Array.isArray(parsed.lockedPackages)
            ? (parsed.lockedPackages as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 30)
            : [];
        return {
            weatherForecastUrl: typeof parsed.weatherForecastUrl === "string" && parsed.weatherForecastUrl.trim()
                ? parsed.weatherForecastUrl.trim().slice(0, 2000)
                : DEFAULT_SETTINGS.weatherForecastUrl,
            weatherReverseUrl: typeof parsed.weatherReverseUrl === "string" && parsed.weatherReverseUrl.trim()
                ? parsed.weatherReverseUrl.trim().slice(0, 2000)
                : DEFAULT_SETTINGS.weatherReverseUrl,
            weatherApiKey: typeof parsed.weatherApiKey === "string" ? parsed.weatherApiKey.trim().slice(0, 500) : "",
            focusDefaultMinutes: clampInt(parsed.focusDefaultMinutes, 1, 240, DEFAULT_SETTINGS.focusDefaultMinutes),
            screenBreakDefaultSeconds: clampInt(parsed.screenBreakDefaultSeconds, 5, 3600, DEFAULT_SETTINGS.screenBreakDefaultSeconds),
            lockedPackages: packages,
            notificationDefaultLimit: clampInt(parsed.notificationDefaultLimit, 1, 50, DEFAULT_SETTINGS.notificationDefaultLimit),
            paymentDefaultLimit: clampInt(parsed.paymentDefaultLimit, 1, 100, DEFAULT_SETTINGS.paymentDefaultLimit),
            paymentDefaultSource: source,
            customActions: normalizeCustomActions(parsed.customActions),
            triggerRules: normalizeTriggerRules(parsed.triggerRules),
            ruleCheckIntervalSec: clampInt(parsed.ruleCheckIntervalSec, 10, 300, DEFAULT_SETTINGS.ruleCheckIntervalSec),

            permissionLevels: {
                standard: parsed.permissionLevels?.standard !== false,
                accessibility: parsed.permissionLevels?.accessibility !== false,
                debugger: parsed.permissionLevels?.debugger === true,
                admin: parsed.permissionLevels?.admin === true,
                root: parsed.permissionLevels?.root === true,
            },
            rootSuCommand: typeof parsed.rootSuCommand === "string" && parsed.rootSuCommand.trim() ? parsed.rootSuCommand.trim().slice(0, 200) : "su",

            voiceEnabled: parsed.voiceEnabled !== false,
            sttMode: parsed.sttMode === "online" || parsed.sttMode === "cloud" ? parsed.sttMode : "system",
            sttOnlineUrl: typeof parsed.sttOnlineUrl === "string" ? parsed.sttOnlineUrl.trim().slice(0, 1000) : "",
            sttOnlineKey: typeof parsed.sttOnlineKey === "string" ? parsed.sttOnlineKey.trim().slice(0, 500) : "",
            sttOnlineModel: typeof parsed.sttOnlineModel === "string" && parsed.sttOnlineModel.trim() ? parsed.sttOnlineModel.trim().slice(0, 100) : DEFAULT_SETTINGS.sttOnlineModel,
            wakeWordEnabled: parsed.wakeWordEnabled === true,
            wakeWordText: typeof parsed.wakeWordText === "string" && parsed.wakeWordText.trim() ? parsed.wakeWordText.trim().slice(0, 20) : DEFAULT_SETTINGS.wakeWordText,
            wakeWordMode: parsed.wakeWordMode === "on_device" ? "on_device" : "system",
            wakeWordAction: parsed.wakeWordAction === "chat" ? "chat" : "floating",
            callRingEnabled: parsed.callRingEnabled !== false,
            callRingTimeoutSec: clampInt(parsed.callRingTimeoutSec, 5, 120, DEFAULT_SETTINGS.callRingTimeoutSec),

            ocrEnabled: parsed.ocrEnabled === true,
            ocrEngine: parsed.ocrEngine === "online" || parsed.ocrEngine === "web" ? parsed.ocrEngine : "mlkit",
            ocrOnlineUrl: typeof parsed.ocrOnlineUrl === "string" ? parsed.ocrOnlineUrl.trim().slice(0, 1000) : "",
            ocrOnlineKey: typeof parsed.ocrOnlineKey === "string" ? parsed.ocrOnlineKey.trim().slice(0, 500) : "",
            ocrScanPackages: Array.isArray(parsed.ocrScanPackages)
                ? (parsed.ocrScanPackages as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20)
                : DEFAULT_SETTINGS.ocrScanPackages,
            ocrResultKeywords: Array.isArray(parsed.ocrResultKeywords)
                ? (parsed.ocrResultKeywords as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20)
                : DEFAULT_SETTINGS.ocrResultKeywords,
            ocrAmountRegex: typeof parsed.ocrAmountRegex === "string" && parsed.ocrAmountRegex.trim() ? parsed.ocrAmountRegex.trim().slice(0, 300) : DEFAULT_SETTINGS.ocrAmountRegex,
            ocrConfirmRequired: parsed.ocrConfirmRequired !== false,
            ocrDedupeWindowMin: clampInt(parsed.ocrDedupeWindowMin, 1, 1440, DEFAULT_SETTINGS.ocrDedupeWindowMin),
            ocrScanIntervalSec: clampInt(parsed.ocrScanIntervalSec, 10, 600, DEFAULT_SETTINGS.ocrScanIntervalSec),

            whereaboutsEnabled: parsed.whereaboutsEnabled !== false,
            whereaboutsPrivacyMode: parsed.whereaboutsPrivacyMode === "diagnostic" || parsed.whereaboutsPrivacyMode === "off" ? parsed.whereaboutsPrivacyMode : "semantic",
            whereaboutsHomeLat: Number.isFinite(Number(parsed.whereaboutsHomeLat)) ? Number(parsed.whereaboutsHomeLat) : null,
            whereaboutsHomeLng: Number.isFinite(Number(parsed.whereaboutsHomeLng)) ? Number(parsed.whereaboutsHomeLng) : null,
            whereaboutsPlaces: normalizePlaces(parsed.whereaboutsPlaces),
            whereaboutsGeofenceRadiusM: clampInt(parsed.whereaboutsGeofenceRadiusM, 50, 2000, DEFAULT_SETTINGS.whereaboutsGeofenceRadiusM),
            whereaboutsExitHysteresisM: clampInt(parsed.whereaboutsExitHysteresisM, 10, 1000, DEFAULT_SETTINGS.whereaboutsExitHysteresisM),
            whereaboutsRetentionDays: clampInt(parsed.whereaboutsRetentionDays, 1, 365, DEFAULT_SETTINGS.whereaboutsRetentionDays),
            whereaboutsScanIntervalSec: clampInt(parsed.whereaboutsScanIntervalSec, 60, 3600, DEFAULT_SETTINGS.whereaboutsScanIntervalSec),

            healthEnabled: parsed.healthEnabled === true,
            healthSource: parsed.healthSource === "json" ? "json" : (parsed.healthSource === "off" ? "off" : "gadgetbridge_sqlite"),
            healthExportPath: typeof parsed.healthExportPath === "string" ? parsed.healthExportPath.trim().slice(0, 1000) : "",
            healthRefreshIntervalSec: clampInt(parsed.healthRefreshIntervalSec, 60, 86400, DEFAULT_SETTINGS.healthRefreshIntervalSec),

            companionEnabled: parsed.companionEnabled === true,
            companionLocationArrived: parsed.companionLocationArrived !== false,
            companionLocationLeft: parsed.companionLocationLeft !== false,
            companionLocationPlace: parsed.companionLocationPlace !== false,
            companionLowBattery: parsed.companionLowBattery !== false,
            companionLowBatteryThreshold: clampInt(parsed.companionLowBatteryThreshold, 5, 50, DEFAULT_SETTINGS.companionLowBatteryThreshold),
            companionSleepShort: parsed.companionSleepShort !== false,
            companionSleepThresholdMinutes: clampInt(parsed.companionSleepThresholdMinutes, 60, 720, DEFAULT_SETTINGS.companionSleepThresholdMinutes),
            companionSevereWeather: parsed.companionSevereWeather !== false,
            companionWeatherCodeMin: clampInt(parsed.companionWeatherCodeMin, 0, 99, DEFAULT_SETTINGS.companionWeatherCodeMin),
            companionWeatherPattern: typeof parsed.companionWeatherPattern === "string" && parsed.companionWeatherPattern.trim() ? parsed.companionWeatherPattern.trim().slice(0, 200) : DEFAULT_SETTINGS.companionWeatherPattern,
            companionTitle: typeof parsed.companionTitle === "string" && parsed.companionTitle.trim() ? parsed.companionTitle.trim().slice(0, 30) : DEFAULT_SETTINGS.companionTitle,
            companionTemplates: normalizeCompanionTemplates(parsed.companionTemplates),
            companionLatched: normalizeCompanionLatched(parsed.companionLatched),
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveHuaweiShellSettings(settings: HuaweiShellSettings): void {
    kvSet(HUAWEI_SHELL_SETTINGS_KEY, JSON.stringify(settings));
}

export function resetHuaweiShellSettings(): void {
    saveHuaweiShellSettings({ ...DEFAULT_SETTINGS });
}

/* ---------- 自定义快捷动作（登记后自动生成 char 工具） ---------- */

const HUAWEI_CUSTOM_ACTION_TYPES = new Set(["open_app", "send_notification", "read_status", "shell"]);
const HUAWEI_STATUS_KEYS = new Set([
    "battery", "volume", "network", "accessibility", "floating", "locked",
    "location", "current_app",
]);

function normalizeCustomActions(raw: unknown): HuaweiCustomAction[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const list: HuaweiCustomAction[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const name = String(r.name ?? "").trim().slice(0, 30);
        const typeRaw = r.type;
        const type = typeof typeRaw === "string" && HUAWEI_CUSTOM_ACTION_TYPES.has(typeRaw) ? typeRaw as HuaweiCustomAction["type"] : null;
        if (!name || !type) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        list.push({
            id: String(r.id ?? `action_${Date.now().toString(36)}_${list.length}`),
            name,
            type,
            description: String(r.description ?? "").trim().slice(0, 300),
            packageName: typeof r.packageName === "string" ? r.packageName.trim().slice(0, 200) : undefined,
            title: typeof r.title === "string" ? r.title.trim().slice(0, 100) : undefined,
            content: typeof r.content === "string" ? r.content.trim().slice(0, 500) : undefined,
            openApp: typeof r.openApp === "string" ? r.openApp.trim().slice(0, 200) : undefined,
            statusKey: typeof r.statusKey === "string" && HUAWEI_STATUS_KEYS.has(r.statusKey) ? r.statusKey as HuaweiStatusKey : undefined,
            command: typeof r.command === "string" ? r.command.trim().slice(0, 2000) : undefined,
            enabled: r.enabled !== false,
            createdAt: Number(r.createdAt) || Date.now(),
        });
        if (list.length >= 30) break;
    }
    return list;
}

/** 读用户登记的自定义快捷动作（自动生成 char 工具用）。 */
export function loadHuaweiCustomActions(): HuaweiCustomAction[] {
    return loadHuaweiShellSettings().customActions;
}

/** 保存自定义快捷动作（会保留其它设置字段）。 */
export function saveHuaweiCustomActions(actions: HuaweiCustomAction[]): void {
    const settings = loadHuaweiShellSettings();
    settings.customActions = normalizeCustomActions(actions);
    saveHuaweiShellSettings(settings);
}

/* ---------- 自动联动规则（通知 / 定时触发动作） ---------- */

const HUAWEI_TRIGGER_TYPES = new Set(["notification", "time"]);
const HUAWEI_RULE_ACTIONS = new Set(["send_notification", "open_app"]);
const HUAWEI_WEEKDAYS = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

function normalizeTriggerRules(raw: unknown): HuaweiTriggerRule[] {
    if (!Array.isArray(raw)) return [];
    const list: HuaweiTriggerRule[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const name = String(r.name ?? "").trim().slice(0, 50);
        const triggerRaw = r.trigger;
        const trigger = typeof triggerRaw === "string" && HUAWEI_TRIGGER_TYPES.has(triggerRaw) ? triggerRaw as HuaweiTriggerRule["trigger"] : null;
        if (!name || !trigger) continue;
        const days = Array.isArray(r.days)
            ? (r.days as unknown[]).filter((d): d is string => typeof d === "string" && HUAWEI_WEEKDAYS.has(d)).slice(0, 7)
            : [];
        list.push({
            id: String(r.id ?? `rule_${Date.now().toString(36)}_${list.length}`),
            name,
            enabled: r.enabled !== false,
            trigger,
            notifyPkg: typeof r.notifyPkg === "string" ? r.notifyPkg.trim().slice(0, 200) : undefined,
            notifyKeyword: typeof r.notifyKeyword === "string" ? r.notifyKeyword.trim().slice(0, 100) : undefined,
            time: typeof r.time === "string" && /^\d{2}:\d{2}$/.test(r.time.trim()) ? r.time.trim() : undefined,
            days,
            action: typeof r.action === "string" && HUAWEI_RULE_ACTIONS.has(r.action) ? r.action as HuaweiTriggerRule["action"] : "send_notification",
            title: typeof r.title === "string" ? r.title.trim().slice(0, 100) : undefined,
            content: typeof r.content === "string" ? r.content.trim().slice(0, 500) : undefined,
            openApp: typeof r.openApp === "string" ? r.openApp.trim().slice(0, 200) : undefined,
            actionPackageName: typeof r.actionPackageName === "string" ? r.actionPackageName.trim().slice(0, 200) : undefined,
            lastTriggeredAt: Number(r.lastTriggeredAt) || undefined,
            lastSeenTs: Number(r.lastSeenTs) || undefined,
            triggerCount: Number(r.triggerCount) || undefined,
        });
        if (list.length >= 30) break;
    }
    return list;
}

/** 读自动联动规则。 */
export function loadHuaweiTriggerRules(): HuaweiTriggerRule[] {
    return loadHuaweiShellSettings().triggerRules;
}

/** 保存自动联动规则（会保留其它设置字段）。 */
export function saveHuaweiTriggerRules(rules: HuaweiTriggerRule[]): void {
    const settings = loadHuaweiShellSettings();
    settings.triggerRules = normalizeTriggerRules(rules);
    saveHuaweiShellSettings(settings);
}

/** 联动规则检查间隔（秒），供调度器读取。 */
export function getHuaweiRuleCheckIntervalSec(): number {
    return loadHuaweiShellSettings().ruleCheckIntervalSec;
}

/* ---------- window.AndroidShell 安全访问 ---------- */

export function getAndroidShell(): HuaweiShellBridge | null {
    if (typeof window === "undefined") return null;
    const shell = (window as unknown as { AndroidShell?: HuaweiShellBridge }).AndroidShell;
    return shell && typeof shell === "object" ? shell : null;
}

/** 特征检测：是否运行在华为壳 WebView 里（页面侧也用于显示连接状态） */
export function isHuaweiShellAvailable(): boolean {
    return getAndroidShell() !== null;
}

export function parseShellJson<T = ShellJsonResult>(raw: string | undefined | null): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** 统一执行一个桥方法并解析 JSON 外壳；方法不存在视为壳不可用。 */
export function invokeShellJson<T = ShellJsonResult>(
    method: (shell: HuaweiShellBridge) => string | undefined | null,
): { ok: true; data: T } | { ok: false; error: string } {
    const shell = getAndroidShell();
    if (!shell) return { ok: false, error: "华为壳未连接（请通过华为壳 App 打开本站）" };
    let raw: string | undefined | null;
    try {
        raw = method(shell);
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const parsed = parseShellJson<T>(raw);
    if (!parsed || typeof parsed !== "object") {
        return { ok: false, error: "华为壳返回了无法解析的结果" };
    }
    const record = parsed as unknown as ShellJsonResult;
    if (record.ok === false) {
        return { ok: false, error: String(record.error ?? "华为壳执行失败") };
    }
    return { ok: true, data: parsed };
}

/* ---------- 设置页专用：一键下发门禁锁列表 / 悬浮球 / 电池优化引导 ---------- */

/** 把设置页里的锁 App 列表同步到壳（setLockedPackages 接收 JSON 数组字符串）。 */
export function pushLockedPackagesToShell(packages: string[]): { ok: boolean; error?: string } {
    const shell = getAndroidShell();
    if (!shell || typeof shell.setLockedPackages !== "function") {
        return { ok: false, error: "华为壳未连接" };
    }
    try {
        const result = parseShellJson<ShellJsonResult>(shell.setLockedPackages(JSON.stringify(packages)));
        if (!result) return { ok: false, error: "壳返回了无法解析的结果" };
        if (!result.ok) return { ok: false, error: String(result.error ?? "设置失败") };
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/** 读取壳当前门禁锁列表（设置页初始化用，壳里可能已被其他端改过）。 */
export function readLockedPackagesFromShell(): string[] {
    const shell = getAndroidShell();
    if (!shell || typeof shell.getLockedPackages !== "function") return [];
    const parsed = parseShellJson<string[]>(shell.getLockedPackages());
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

/* ---------- 天气（实时定位 + 可配接口模板，设置页预览与角色工具共用） ---------- */

/** WMO 天气码 → 中文描述 */
export const HUAWEI_WEATHER_CODES: Record<number, string> = {
    0: "晴",
    1: "大部晴朗",
    2: "多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "浓毛毛雨",
    56: "冻毛毛雨",
    57: "强冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "小阵雨",
    81: "阵雨",
    82: "强阵雨",
    85: "小阵雪",
    86: "大阵雪",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹",
};

export function huaweiWeatherCodeLabel(code: number): string {
    return HUAWEI_WEATHER_CODES[code] || `天气码 ${code}`;
}

/** 渲染接口地址模板：{lat} {lng} {key} 占位符；没填 Key 时 {key} 替换为空。 */
export function renderHuaweiUrl(template: string, lat: number, lng: number, apiKey: string): string {
    return template
        .replace(/\{lat\}/g, String(lat))
        .replace(/\{lng\}/g, String(lng))
        .replace(/\{key\}/g, apiKey ? encodeURIComponent(apiKey) : "");
}

async function huaweiFetchText(url: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
    } finally {
        clearTimeout(timer);
    }
}

/** 实时天气（当前定位 + 逆地理城市名 + 天气），供角色工具与设置页预览共用。 */
export async function fetchHuaweiCurrentWeather(): Promise<{ ok: boolean; data?: string; error?: string }> {
    const loc = invokeShellJson<Record<string, unknown>>(shell => (shell.getLocation ? shell.getLocation() : null));
    if (!loc.ok) return { ok: false, error: `拿不到定位：${loc.error}` };
    const lat = Number(loc.data.lat);
    const lng = Number(loc.data.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { ok: false, error: "定位结果缺少经纬度" };
    }
    const settings = loadHuaweiShellSettings();
    let city = "";
    try {
        const reverseText = await huaweiFetchText(renderHuaweiUrl(settings.weatherReverseUrl, lat, lng, settings.weatherApiKey), 4000);
        const reverse = JSON.parse(reverseText) as { results?: Array<{ name?: string; country?: string }> };
        const result = reverse.results?.[0];
        if (result?.name) city = `${result.name}${result.country && result.country !== "CN" ? `，${result.country}` : ""}`;
    } catch { /* 逆地理失败不阻塞天气 */ }

    let forecast: unknown;
    try {
        forecast = JSON.parse(await huaweiFetchText(renderHuaweiUrl(settings.weatherForecastUrl, lat, lng, settings.weatherApiKey), 8000));
    } catch (err) {
        return { ok: false, error: `天气服务请求失败：${err instanceof Error ? err.message : String(err)}` };
    }
    const current = (forecast as { current?: Record<string, unknown> })?.current;
    if (!current) return { ok: false, error: "天气服务返回了无法识别的数据" };
    const parts: string[] = [];
    const code = Number(current.weather_code);
    if (Number.isFinite(code)) parts.push(huaweiWeatherCodeLabel(code));
    if (typeof current.temperature_2m === "number") parts.push(`${Math.round(current.temperature_2m)}°`);
    if (typeof current.apparent_temperature === "number") parts.push(`体感 ${Math.round(current.apparent_temperature)}°`);
    if (typeof current.relative_humidity_2m === "number") parts.push(`湿度 ${Math.round(current.relative_humidity_2m)}%`);
    if (typeof current.precipitation === "number" && current.precipitation > 0) parts.push(`降水 ${current.precipitation}mm`);
    if (typeof current.wind_speed_10m === "number") parts.push(`风速 ${current.wind_speed_10m}m/s`);
    const where = city || `坐标 ${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    return { ok: true, data: `${where}：${parts.join("，")}` };
}

/* ---------- 语义行踪与足迹 ---------- */

const HUAWEI_FOOTPRINT_KEY = "ai_phone_huawei_footprint_v1";
registerKvMigration(HUAWEI_FOOTPRINT_KEY);

export function loadHuaweiFootprint(): HuaweiFootprintEntry[] {
    try {
        const raw = kvGet(HUAWEI_FOOTPRINT_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return (parsed as HuaweiFootprintEntry[]).filter((e): e is HuaweiFootprintEntry => {
            if (!e || typeof e !== "object") return false;
            const r = e as Record<string, unknown>;
            return Number.isFinite(Number(r.ts)) && typeof r.semantic === "string";
        }).slice(0, 2000);
    } catch { return []; }
}

export function saveHuaweiFootprint(entries: HuaweiFootprintEntry[]): void {
    kvSet(HUAWEI_FOOTPRINT_KEY, JSON.stringify(entries.slice(0, 2000)));
}

/** 追加一条足迹并按保留天数裁剪。 */
export function appendHuaweiFootprint(entry: HuaweiFootprintEntry, retentionDays: number): HuaweiFootprintEntry[] {
    const current = loadHuaweiFootprint();
    const next = [entry, ...current];
    const cutoff = Date.now() - retentionDays * 86400000;
    const trimmed = next.filter(e => e.ts >= cutoff).slice(0, 1000);
    saveHuaweiFootprint(trimmed);
    return trimmed;
}

/* ---------- 穿戴健康快照 ---------- */

const HUAWEI_HEALTH_SNAPSHOT_KEY = "ai_phone_huawei_health_snapshot_v1";
registerKvMigration(HUAWEI_HEALTH_SNAPSHOT_KEY);

export function loadHuaweiHealthSnapshot(): HuaweiHealthSnapshot | null {
    try {
        const raw = kvGet(HUAWEI_HEALTH_SNAPSHOT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as HuaweiHealthSnapshot;
        if (!parsed || typeof parsed.status !== "string") return null;
        return parsed;
    } catch { return null; }
}

export function saveHuaweiHealthSnapshot(snapshot: HuaweiHealthSnapshot): void {
    kvSet(HUAWEI_HEALTH_SNAPSHOT_KEY, JSON.stringify({ ...snapshot, updatedAt: Date.now() }));
}

/* ---------- normalize 辅助（新增字段） ---------- */

function normalizePlaces(raw: unknown): HuaweiPlace[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is HuaweiPlace => {
        if (!item || typeof item !== "object") return false;
        const r = item as Record<string, unknown>;
        return typeof r.name === "string" && r.name.trim().length > 0
            && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng));
    }).slice(0, 20).map((r) => ({
        name: String(r.name).trim().slice(0, 40),
        lat: Number(r.lat),
        lng: Number(r.lng),
        radiusM: clampInt(r.radiusM, 50, 2000, 150),
    }));
}

const COMPANION_TEMPLATE_DEFAULTS = {
    arrivedHome: "你到家啦，辛苦啦。",
    leftHome: "你出门啦，路上注意安全。",
    atPlace: "你到「{place}」了。",
    lowBattery: "手机快没电了（剩 {level}%），记得充电。",
    sleepShort: "昨晚只睡了 {minutes}，记得补觉。",
    severeWeather: "{condition}，出门注意安全。",
};

function normalizeCompanionTemplates(raw: unknown): HuaweiShellSettings["companionTemplates"] {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const out: HuaweiShellSettings["companionTemplates"] = { ...COMPANION_TEMPLATE_DEFAULTS };
    (Object.keys(COMPANION_TEMPLATE_DEFAULTS) as Array<keyof typeof COMPANION_TEMPLATE_DEFAULTS>).forEach(k => {
        if (typeof r[k] === "string" && String(r[k]).trim()) out[k] = String(r[k]).trim().slice(0, 200);
    });
    return out;
}

function normalizeCompanionLatched(raw: unknown): HuaweiShellSettings["companionLatched"] {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
        lastArrivedDate: typeof r.lastArrivedDate === "string" ? r.lastArrivedDate : "",
        lastLeftDate: typeof r.lastLeftDate === "string" ? r.lastLeftDate : "",
        lastPlaceDate: typeof r.lastPlaceDate === "string" ? r.lastPlaceDate : "",
        lastLowBatteryLevel: Number.isFinite(Number(r.lastLowBatteryLevel)) ? Number(r.lastLowBatteryLevel) : null,
        lastSleepDate: typeof r.lastSleepDate === "string" ? r.lastSleepDate : "",
        lastWeatherAlert: typeof r.lastWeatherAlert === "string" ? r.lastWeatherAlert : "",
    };
}

/* ---------- OCR 记账入账（与通知解析并行，同一笔按金额+来源+时间窗口去重） ---------- */

export type HuaweiOcrParsed = {
    ok: boolean;
    text: string;
    amount?: number;
    merchant?: string;
    source?: PaymentSource;
    pkg?: string;
    engine?: "mlkit" | "online" | "web";
    error?: string;
};

function extractOcrAmount(text: string, regex: string): number | undefined {
    try {
        const m = new RegExp(regex, "g").exec(text);
        if (!m || !m[0]) return undefined;
        const cleaned = m[0].replace(/[¥￥\s元]/g, "");
        const n = Number(cleaned);
        return Number.isFinite(n) && n > 0 ? n : undefined;
    } catch { return undefined; }
}

/** 把 OCR 识别结果写入记账应用同一存储（collection ledger / key records），
 *  与通知解析共用数据源；去重窗口与是否需人工确认均读设置，不写死。 */
export function addHuaweiLedgerRecordFromOcr(parsed: HuaweiOcrParsed): { ok: boolean; added: boolean; confirm: boolean; error?: string } {
    if (!parsed.ok) return { ok: false, added: false, confirm: false, error: parsed.error || "识别失败" };
    const settings = loadHuaweiShellSettings();
    const amount = parsed.amount ?? extractOcrAmount(parsed.text, settings.ocrAmountRegex);
    if (!amount) return { ok: false, added: false, confirm: false, error: "未识别到有效金额" };
    const pkg = parsed.pkg || "";
    const source: "wechat" | "alipay" | "cash" | "manual" = pkg === WECHAT_PACKAGE
        ? "wechat"
        : pkg === ALIPAY_PACKAGE
            ? "alipay"
            : (parsed.source === "wechat" || parsed.source === "alipay" ? parsed.source : "manual");
    const merchant = (parsed.merchant || parsed.text.replace(amountTextPattern(settings.ocrAmountRegex), "").trim().slice(0, 40) || "屏幕交易").trim();
    const current = loadLedgerRecords();
    const windowMs = settings.ocrDedupeWindowMin * 60000;
    const now = Date.now();
    const dup = current.some(entry =>
        entry.source === source
        && entry.amount === amount
        && entry.ts && now - entry.ts < windowMs
    );
    if (dup) return { ok: true, added: false, confirm: false };
    const entry: HuaweiLedgerRecord = {
        id: `ocr_${now}_${Math.random().toString(36).slice(2, 8)}`,
        date: new Date(now).toISOString().slice(0, 10),
        type: "expense",
        amount,
        category: "其他",
        note: settings.ocrConfirmRequired ? "[待确认] 屏幕识别" : "屏幕识别",
        merchant,
        source,
        auto: true,
        ts: now,
    };
    const merged = [entry, ...current].slice(0, 5000);
    saveLedgerRecords(merged);
    return { ok: true, added: true, confirm: settings.ocrConfirmRequired };
}

function amountTextPattern(regex: string): RegExp {
    try { return new RegExp(regex, "g"); } catch { return /([¥￥]\s*\d+(?:\.\d{1,2})?)/g; }
}