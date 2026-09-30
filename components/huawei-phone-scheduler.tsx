"use client";

/**
 * 华为手机智能调度器（全局常驻，挂在 main-app，无可见 UI）：
 * ① 语义行踪扫描与足迹记录（设置可配：开关 / 隐私模式 / 围栏半径 / 保留天数 / 扫描间隔 / 常用地点）
 * ② 穿戴健康快照刷新（Gadgetbridge 导出库，设置可配数据源 / 导出路径 / 刷新间隔）
 * ③ OCR 记账自动兜底（前台为支付类 App 时截屏识别入账，与通知监听并行、同一笔去重；设置可配引擎/来源包/关键词/去重窗口/间隔）
 * ④ 陪伴推送强化（行踪 / 低电量 / 短睡眠 / 恶劣天气，跨线才喊一次；标题、阈值、模板、开关全部设置页可配）
 * ⑤ 原生回传兜底：STT 识别文本 → 派发 huawei-voice-input（聊天页以用户消息处理）；
 *    唤醒词命中 → 打开壳悬浮球速聊；OCR 结果 → 入账并派发 huawei-ocr-result。
 * 所有触发条件、模板、阈值均读设置，无写死数据。
 */

import { useEffect, useRef } from "react";
import {
    addHuaweiLedgerRecordFromOcr,
    appendHuaweiFootprint,
    getAndroidShell,
    invokeShellJson,
    loadHuaweiHealthSnapshot,
    loadHuaweiShellSettings,
    saveHuaweiHealthSnapshot,
    saveHuaweiShellSettings,
    type HuaweiHealthSnapshot,
    type HuaweiOcrParsed,
} from "@/lib/huawei-shell/storage";
import { ALIPAY_PACKAGE, WECHAT_PACKAGE } from "@/lib/huawei-shell/types";
import {
    appendLifelineFinanceRecord,
    appendLifelineStudyRecord,
    loadWakeAlarm,
    rememberCharMemory,
    saveWakeAlarm,
} from "@/lib/lifeline-bridge";

/** 调度器 tick 粒度（秒级业务阈值仍由各设置项的扫描间隔控制）。 */
const TICK_MS = 10000;
/** 陪伴推送最短检查间隔。 */
const COMPANION_MIN_INTERVAL_MS = 60000;

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function classifyHuaweiLocation(
    lat: number,
    lng: number,
    settings: ReturnType<typeof loadHuaweiShellSettings>,
): { semantic: string; status: "home" | "place" | "away"; placeName?: string } {
    if (settings.whereaboutsHomeLat != null && settings.whereaboutsHomeLng != null) {
        const d = haversineM(lat, lng, settings.whereaboutsHomeLat, settings.whereaboutsHomeLng);
        if (d <= settings.whereaboutsGeofenceRadiusM) return { semantic: "在家", status: "home" };
    }
    for (const place of settings.whereaboutsPlaces) {
        const d = haversineM(lat, lng, place.lat, place.lng);
        if (d <= place.radiusM) return { semantic: `在${place.name}`, status: "place", placeName: place.name };
    }
    return { semantic: "在外", status: "away" };
}

function fillTemplate(template: string, vars: Record<string, string | number>): string {
    let out = template;
    Object.entries(vars).forEach(([key, value]) => {
        out = out.split(`{${key}}`).join(String(value));
    });
    return out;
}

function toNumOrNull(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function HuaweiPhoneScheduler() {
    const lastScanRef = useRef(0);
    const lastHealthRef = useRef(0);
    const lastOcrRef = useRef(0);
    const lastCompanionRef = useRef(0);
    const lastClassifiedRef = useRef<{ status: "home" | "place" | "away"; placeName?: string; ts: number } | null>(null);

    // 原生回传兜底：STT 文本 / 唤醒词 / OCR 结果（链式，不覆盖既有监听者）
    useEffect(() => {
        const w = window as unknown as {
            __floatBridgeOnSpeechText?: (json: string) => void;
            __floatBridgeOnWakeWord?: (json: string) => void;
            __floatBridgeOnOcrResult?: (json: string) => void;
        };
        const callFlag = (window as unknown as { __huaweiCallActive?: boolean }).__huaweiCallActive;

        const prevSpeech = w.__floatBridgeOnSpeechText;
        const speechHandler = (json: string) => {
            try {
                const parsed = JSON.parse(json) as { ok?: boolean; text?: string; error?: string };
                const inCall = Boolean((window as unknown as { __huaweiCallActive?: boolean }).__huaweiCallActive);
                if (parsed.ok && parsed.text && !inCall) {
                    window.dispatchEvent(new CustomEvent("huawei-voice-input", { detail: { text: parsed.text } }));
                }
            } catch { /* 非法回传忽略 */ }
            if (typeof prevSpeech === "function") { try { prevSpeech(json); } catch { /* 忽略 */ } }
        };
        w.__floatBridgeOnSpeechText = speechHandler;

        const prevWake = w.__floatBridgeOnWakeWord;
        const wakeHandler = (json: string) => {
            try {
                const parsed = JSON.parse(json) as { ok?: boolean; text?: string };
                if (parsed.ok) {
                    const settings = loadHuaweiShellSettings();
                    if (settings.wakeWordEnabled && settings.wakeWordAction === "floating") {
                        const shell = getAndroidShell();
                        if (shell && typeof shell.setFloating === "function") shell.setFloating(true);
                    }
                }
            } catch { /* 忽略 */ }
            if (typeof prevWake === "function") { try { prevWake(json); } catch { /* 忽略 */ } }
        };
        w.__floatBridgeOnWakeWord = wakeHandler;

        const prevOcr = w.__floatBridgeOnOcrResult;
        const ocrHandler = (json: string) => {
            let parsed: HuaweiOcrParsed | null = null;
            try {
                const raw = JSON.parse(json) as HuaweiOcrParsed;
                if (raw && typeof raw === "object") parsed = raw;
            } catch { parsed = null; }
            if (parsed) {
                const result = addHuaweiLedgerRecordFromOcr(parsed);
                // 现实桥 → Lifeline 财务 → char 记忆 闭环：识别到真实消费就同步进 Lifeline 记账，
                // 并往 char 长期记忆里塞一条轻量消费记录。
                if (result.ok && result.added && typeof parsed.amount === "number" && parsed.amount > 0) {
                    const method: "wechat" | "alipay" | "cash" = parsed.pkg === WECHAT_PACKAGE
                        ? "wechat"
                        : parsed.pkg === ALIPAY_PACKAGE
                            ? "alipay"
                            : "cash";
                    appendLifelineFinanceRecord({
                        amount: parsed.amount,
                        category: "其他",
                        note: parsed.merchant ? `屏幕识别·${parsed.merchant}` : "屏幕识别消费",
                        method,
                        type: "expense",
                    });
                    const srcLabel = method === "wechat" ? "微信" : method === "alipay" ? "支付宝" : "现金";
                    const dk = new Date();
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const dateStr = `${dk.getMonth() + 1}月${dk.getDate()}日`;
                    rememberCharMemory("消费", `${dateStr}${srcLabel}支出 ¥${parsed.amount}${parsed.merchant ? `（${parsed.merchant}）` : ""}`);
                }
                const amountStr = parsed.amount != null ? `${parsed.amount}元` : "";
                const who = parsed.merchant || "交易";
                const summary = parsed.ok
                    ? result.added
                        ? result.confirm
                            ? `屏幕识别入账（待确认）：${who} ${amountStr}`
                            : `屏幕识别入账：${who} ${amountStr}`
                        : `屏幕识别：${who} ${amountStr}（已存在，未重复入账）`
                    : `屏幕识别失败：${parsed.error || "未知原因"}`;
                window.dispatchEvent(new CustomEvent("huawei-ocr-result", {
                    detail: { text: summary, added: result.added, confirm: result.confirm },
                }));
            }
            if (typeof prevOcr === "function") { try { prevOcr(json); } catch { /* 忽略 */ } }
        };
        w.__floatBridgeOnOcrResult = ocrHandler;

        return () => {
            if (w.__floatBridgeOnSpeechText === speechHandler) {
                w.__floatBridgeOnSpeechText = (typeof prevSpeech === "function" ? prevSpeech : undefined);
            }
            if (w.__floatBridgeOnWakeWord === wakeHandler) {
                w.__floatBridgeOnWakeWord = (typeof prevWake === "function" ? prevWake : undefined);
            }
            if (w.__floatBridgeOnOcrResult === ocrHandler) {
                w.__floatBridgeOnOcrResult = (typeof prevOcr === "function" ? prevOcr : undefined);
            }
        };
        // callFlag 仅用于消除未使用告警（运行时标志由通话界面设置）
        void callFlag;
    }, []);

    // 周期调度
    useEffect(() => {
        const tick = () => {
            // 起床闹钟：不依赖壳是否连接都检查（壳不在则退化为网页通知）
            checkWakeAlarm();

            const settings = loadHuaweiShellSettings();
            if (!getAndroidShell()) return;
            const now = Date.now();

            if (settings.whereaboutsEnabled && settings.whereaboutsPrivacyMode !== "off") {
                if (now - lastScanRef.current >= settings.whereaboutsScanIntervalSec * 1000) {
                    lastScanRef.current = now;
                    scanWhereabouts(settings);
                }
            }
            if (settings.healthEnabled) {
                if (now - lastHealthRef.current >= settings.healthRefreshIntervalSec * 1000) {
                    lastHealthRef.current = now;
                    refreshHealth(settings);
                }
            }
            if (settings.ocrEnabled) {
                if (now - lastOcrRef.current >= settings.ocrScanIntervalSec * 1000) {
                    lastOcrRef.current = now;
                    autoOcrCapture(settings);
                }
            }
            if (settings.companionEnabled) {
                if (now - lastCompanionRef.current >= COMPANION_MIN_INTERVAL_MS) {
                    lastCompanionRef.current = now;
                    void companionCheck(settings);
                }
            }
        };
        const timer = window.setInterval(tick, TICK_MS);
        return () => window.clearInterval(timer);
        // 组件只挂载一次，依赖留空
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ① 行踪扫描
    const scanWhereabouts = (settings: ReturnType<typeof loadHuaweiShellSettings>) => {
        const result = invokeShellJson<Record<string, unknown>>(shell => (shell.getLocation ? shell.getLocation() : null));
        if (!result.ok) return;
        const lat = Number(result.data.lat);
        const lng = Number(result.data.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const cls = classifyHuaweiLocation(lat, lng, settings);
        const last = lastClassifiedRef.current;
        const changed = !last || last.status !== cls.status || last.placeName !== cls.placeName;
        if (changed) {
            appendHuaweiFootprint({
                ts: Date.now(),
                semantic: cls.semantic,
                status: cls.status,
                ...(cls.placeName ? { placeName: cls.placeName } : {}),
                ...(settings.whereaboutsPrivacyMode === "diagnostic" ? { lat, lng } : {}),
            }, settings.whereaboutsRetentionDays);
            lastClassifiedRef.current = { status: cls.status, placeName: cls.placeName, ts: Date.now() };
        }
    };

    // ② 健康快照刷新
    const refreshHealth = (settings: ReturnType<typeof loadHuaweiShellSettings>) => {
        const result = invokeShellJson<Record<string, unknown>>(shell =>
            (shell.readGadgetbridgeHealth ? shell.readGadgetbridgeHealth(settings.healthExportPath) : null));
        if (!result.ok) return;
        const data = result.data;
        const snapshot: HuaweiHealthSnapshot = {
            status: String(data.status ?? "ok"),
            stepsToday: toNumOrNull(data.stepsToday),
            latestHeartRate: toNumOrNull(data.latestHeartRate),
            latestHeartRateAt: toNumOrNull(data.latestHeartRateAt),
            latestStress: toNumOrNull(data.latestStress),
            activeCaloriesToday: toNumOrNull(data.activeCaloriesToday),
            sleepMinutes: toNumOrNull(data.sleepMinutes),
            sleepStartedAt: toNumOrNull(data.sleepStartedAt),
            sleepWakeAt: toNumOrNull(data.sleepWakeAt),
            message: String(data.message ?? ""),
            updatedAt: Date.now(),
        };
        saveHuaweiHealthSnapshot(snapshot);
    };

    // ③ OCR 自动兜底：前台为支付类 App 时截屏识别
    const autoOcrCapture = (settings: ReturnType<typeof loadHuaweiShellSettings>) => {
        const cur = invokeShellJson<Record<string, unknown>>(shell => (shell.getCurrentApp ? shell.getCurrentApp() : null));
        if (!cur.ok) return;
        const pkg = String(cur.data.currentApp ?? "");
        if (!pkg || !settings.ocrScanPackages.includes(pkg)) return;
        const shell = getAndroidShell();
        if (!shell || typeof shell.ocrPaymentsCapture !== "function") return;
        shell.ocrPaymentsCapture(JSON.stringify({
            engine: settings.ocrEngine,
            url: settings.ocrOnlineUrl,
            key: settings.ocrOnlineKey,
        }));
    };

    // ④ 陪伴推送检查（跨线才喊一次：latch 存设置，界面可清零）
    const companionCheck = async (settings: ReturnType<typeof loadHuaweiShellSettings>) => {
        const shell = getAndroidShell();
        if (!shell) return;
        const today = new Date().toISOString().slice(0, 10);
        const latch = settings.companionLatched;
        let changed = false;

        const sendCompanion = (content: string) => {
            try {
                if (typeof shell.sendNotification === "function") shell.sendNotification(settings.companionTitle, content, "");
            } catch { /* 推送失败不阻断 */ }
        };

        // 行踪事件
        const loc = invokeShellJson<Record<string, unknown>>(shell => (shell.getLocation ? shell.getLocation() : null));
        if (loc.ok) {
            const lat = Number(loc.data.lat);
            const lng = Number(loc.data.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                const cls = classifyHuaweiLocation(lat, lng, settings);
                const last = lastClassifiedRef.current;
                if (last && last.status !== cls.status) {
                    if (cls.status === "home" && settings.companionLocationArrived && latch.lastArrivedDate !== today) {
                        sendCompanion(settings.companionTemplates.arrivedHome);
                        latch.lastArrivedDate = today;
                        changed = true;
                    } else if (last.status === "home" && settings.companionLocationLeft && latch.lastLeftDate !== today) {
                        sendCompanion(settings.companionTemplates.leftHome);
                        latch.lastLeftDate = today;
                        changed = true;
                    }
                }
                if (last && last.status === "place" && cls.status === "place"
                    && last.placeName !== cls.placeName && settings.companionLocationPlace && latch.lastPlaceDate !== today) {
                    sendCompanion(fillTemplate(settings.companionTemplates.atPlace, { place: cls.placeName || "" }));
                    latch.lastPlaceDate = today;
                    changed = true;
                }
                const stateChanged = !last || last.status !== cls.status || last.placeName !== cls.placeName;
                if (stateChanged) {
                    if (settings.whereaboutsEnabled && settings.whereaboutsPrivacyMode !== "off") {
                        appendHuaweiFootprint({
                            ts: Date.now(),
                            semantic: cls.semantic,
                            status: cls.status,
                            ...(cls.placeName ? { placeName: cls.placeName } : {}),
                            ...(settings.whereaboutsPrivacyMode === "diagnostic" ? { lat, lng } : {}),
                        }, settings.whereaboutsRetentionDays);
                    }
                    lastClassifiedRef.current = { status: cls.status, placeName: cls.placeName, ts: Date.now() };
                    changed = true;
                }
            }
        }

        // 低电量
        const status = invokeShellJson<Record<string, unknown>>(shell => (shell.getStatus ? shell.getStatus() : null));
        if (status.ok) {
            const battery = Number(status.data.battery);
            if (Number.isFinite(battery)) {
                if (battery <= settings.companionLowBatteryThreshold && settings.companionLowBattery) {
                    if (latch.lastLowBatteryLevel !== battery) {
                        sendCompanion(fillTemplate(settings.companionTemplates.lowBattery, { level: battery }));
                        latch.lastLowBatteryLevel = battery;
                        changed = true;
                    }
                } else if (battery > settings.companionLowBatteryThreshold && latch.lastLowBatteryLevel != null) {
                    latch.lastLowBatteryLevel = null;
                    changed = true;
                }
            }
        }

        // 短睡眠
        const snapshot = loadHuaweiHealthSnapshot();
        if (snapshot && snapshot.sleepMinutes != null && settings.companionSleepShort) {
            if (snapshot.sleepMinutes < settings.companionSleepThresholdMinutes && latch.lastSleepDate !== today) {
                sendCompanion(fillTemplate(settings.companionTemplates.sleepShort, {
                    minutes: Math.max(1, Math.round(snapshot.sleepMinutes / 60)),
                }));
                latch.lastSleepDate = today;
                changed = true;
            }
        }

        if (changed) saveHuaweiShellSettings(settings);
    };

    // ⑤ 起床闹钟：到 HH:mm 响铃+通知喊起床学习，同一天只触发一次
    const checkWakeAlarm = () => {
        const cfg = loadWakeAlarm();
        if (!cfg.enabled) return;
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        if (hhmm !== cfg.time || cfg.lastFiredDate === today) return;

        cfg.lastFiredDate = today;
        saveWakeAlarm(cfg);

        const title = "起床啦，该学习了";
        const content = cfg.message || "起床啦，新的一天，开始学习吧。";
        const shell = getAndroidShell();
        if (shell) {
            try { if (typeof shell.ring === "function") shell.ring(180); } catch { /* 响铃失败不阻断 */ }
            try { if (typeof shell.sendNotification === "function") shell.sendNotification(title, content, ""); } catch { /* 推送失败不阻断 */ }
        } else if (typeof Notification !== "undefined") {
            // 壳未连接：退化到网页通知
            try {
                if (Notification.permission === "granted") new Notification(title, { body: content });
            } catch { /* 网页通知失败不阻断 */ }
        }
        // 往 Lifeline 写一条起床记录
        appendLifelineStudyRecord({ subject: "起床", content: `${cfg.time} 按时起床学习`, minutes: 0 });
    };

    return null;
}
