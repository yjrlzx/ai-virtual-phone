"use client";

// 华为壳设置：连接状态、权限引导、天气接口、专注/息屏默认、门禁锁 App、通知/记账默认、账本与快速测试。
// 纯增量挂载页：不改任何既有设置 UI，本页独立使用 Y2K 冰蓝千禧复古风格（styles/huawei-shell.css）。

import { useCallback, useEffect, useState } from "react";
import {
    Battery,
    Bell,
    Eye,
    Loader2,
    Lock,
    MapPin,
    Moon,
    Plus,
    Receipt,
    RefreshCw,
    Smartphone,
    Timer,
    Trash2,
    Volume2,
    Wand2,
    Wifi,
    Workflow,
    Zap,
    Mic,
    ScanLine,
    Footprints,
    HeartPulse,
    BellRing,
    ShieldCheck,
} from "lucide-react";
import {
    PAYMENT_SOURCE_OPTIONS,
    getAndroidShell,
    getHuaweiLedgerSummary,
    invokeShellJson,
    isHuaweiShellAvailable,
    loadHuaweiShellSettings,
    pushLockedPackagesToShell,
    readHuaweiLedger,
    readLockedPackagesFromShell,
    resetHuaweiShellSettings,
    loadHuaweiCustomActions,
    loadHuaweiTriggerRules,
    saveHuaweiCustomActions,
    saveHuaweiShellSettings,
    saveHuaweiTriggerRules,
    syncHuaweiLedgerFromShell,
    loadHuaweiHealthSnapshot,
    saveHuaweiHealthSnapshot,
    type HuaweiHealthSnapshot,
    type HuaweiPlace,
    type HuaweiShellSettings,
} from "@/lib/huawei-shell/storage";
import type {
    HuaweiCustomAction,
    HuaweiCustomActionType,
    HuaweiStatusKey,
    HuaweiTriggerRule,
    HuaweiTriggerRuleAction,
    HuaweiTriggerRuleTrigger,
} from "@/lib/huawei-shell/types";
import {
    HUAWEI_SHELL_CAPABILITY_ID,
    loadInternalCapabilities,
    saveInternalCapabilities,
} from "@/lib/internal-capability-storage";

/** 照搬 Operit 五级权限体系（STANDARD / ACCESSIBILITY / DEBUGGER / ADMIN / ROOT），华为 P60 适配说明。 */
const HUAWEI_PERMISSION_LEVELS: Array<{
    key: keyof HuaweiShellSettings["permissionLevels"];
    label: string;
    desc: string;
    risk: string;
    steps: string;
    setting: string;
}> = [
    { key: "standard", label: "标准级", desc: "基础查询与日常操控：状态 / 位置 / 当前应用 / 记账 / 语音 / 剪贴板 / 音量 / 网页 / 健康 / 足迹 / 打开应用", risk: "低：常规应用能力", steps: "无需额外授权，随系统弹窗授予（定位 / 麦克风 / 存储）", setting: "" },
    { key: "accessibility", label: "无障碍级", desc: "屏幕级操控：读屏 / 点击 / 输入 / 滑动 / 按键 / 专注 / 门禁锁 / 通知读取 / 发送提醒", risk: "中：可代你操作屏幕，建议仅信任本应用", steps: "系统设置 → 无障碍 → 辅助功能 → 开启 float 服务", setting: "accessibility" },
    { key: "debugger", label: "调试级", desc: "文件读写与 shell 命令：读取文件 / 运行受限命令", risk: "中高：可访问存储并执行命令", steps: "系统设置 → 开发者选项 → USB/无线调试；文件需授予存储权限", setting: "storage" },
    { key: "admin", label: "管理员级", desc: "系统级能力：截屏识别（媒体投影）/ 悬浮球 / 调节亮度（写设置）", risk: "高：可录制屏幕与修改系统设置", steps: "悬浮窗授权本应用；修改系统设置；截屏时按提示授权媒体投影", setting: "overlay" },
    { key: "root", label: "Root 级", desc: "最高权限 shell（可选）：鸿蒙 P60 普遍难拿，能开则开、不能开明确提示", risk: "极高：完全控制设备，请自行判断", steps: "需手机已 root（Magisk 等）；在下方填 su 命令并检测；未 root 则保持关闭", setting: "shell" },
];

const COMPANION_TEMPLATE_LABELS: Record<keyof HuaweiShellSettings["companionTemplates"], string> = {
    arrivedHome: "到家提醒",
    leftHome: "出门提醒",
    atPlace: "到达地点提醒（占位符 {place}）",
    lowBattery: "低电量提醒（占位符 {level}）",
    sleepShort: "短睡眠提醒（占位符 {minutes}）",
};

export function HuaweiShellSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
    const [settings, setSettings] = useState<HuaweiShellSettings>(() => loadHuaweiShellSettings());
    const [shellAvailable, setShellAvailable] = useState(false);
    const [shellVersion, setShellVersion] = useState("");
    const [capabilityOn, setCapabilityOn] = useState(() => {
        const item = loadInternalCapabilities().find(c => c.id === HUAWEI_SHELL_CAPABILITY_ID);
        return Boolean(item && item.enabled && item.mode !== "off");
    });
    const [accessibility, setAccessibility] = useState<boolean | null>(null);
    const [floating, setFloating] = useState<boolean | null>(null);
    const [lockedDraft, setLockedDraft] = useState<string[]>(() => loadHuaweiShellSettings().lockedPackages);
    const [newPackage, setNewPackage] = useState("");
    const [ledger, setLedger] = useState(() => getHuaweiLedgerSummary());
    const [testOutput, setTestOutput] = useState<{ label: string; text: string; ok: boolean } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [permStatus, setPermStatus] = useState("");
    const [ocrPackagesDraft, setOcrPackagesDraft] = useState<string[]>(() => loadHuaweiShellSettings().ocrScanPackages);
    const [ocrPkgDraft, setOcrPkgDraft] = useState("");
    const [ocrKeywordsDraft, setOcrKeywordsDraft] = useState<string[]>(() => loadHuaweiShellSettings().ocrResultKeywords);
    const [ocrKeywordDraft, setOcrKeywordDraft] = useState("");
    const [placesDraft, setPlacesDraft] = useState<HuaweiPlace[]>(() => loadHuaweiShellSettings().whereaboutsPlaces);
    const [placeDraft, setPlaceDraft] = useState<HuaweiPlace>({ name: "", lat: 0, lng: 0, radiusM: 150 });
    const [healthSnapshot, setHealthSnapshot] = useState<HuaweiHealthSnapshot | null>(() => loadHuaweiHealthSnapshot());

    useEffect(() => {
        const available = isHuaweiShellAvailable();
        setShellAvailable(available);
        const shell = getAndroidShell();
        if (available) {
            if (typeof shell?.getVersion === "function") {
                try { setShellVersion(String(shell.getVersion())); } catch { /* ignore */ }
            }
            try { setAccessibility(shell?.accessibilityActive?.() === true); } catch { setAccessibility(null); }
            const status = invokeShellJson<Record<string, unknown>>(s => (s.getStatus ? s.getStatus() : null));
            if (status.ok && typeof status.data.floating === "boolean") setFloating(status.data.floating);
        }
        setLedger(getHuaweiLedgerSummary());
    }, []);

    const updateSettings = useCallback((patch: Partial<HuaweiShellSettings>) => {
        setSettings(prev => {
            const next = { ...prev, ...patch };
            saveHuaweiShellSettings(next);
            return next;
        });
    }, []);

    const testPermissionStatus = () => {
        const shell = getAndroidShell();
        if (!shell || typeof shell.getPermissionStatus !== "function") {
            onNotice?.("华为壳未连接或版本不支持权限检测");
            return;
        }
        try {
            const raw = shell.getPermissionStatus(settings.rootSuCommand);
            setPermStatus(raw);
            onNotice?.("权限状态已刷新（含 root 探测）");
        } catch (err) {
            setPermStatus(err instanceof Error ? err.message : String(err));
        }
    };

    const addOcrPackage = () => {
        const pkg = ocrPkgDraft.trim();
        if (!pkg) { onNotice?.("先填包名再添加"); return; }
        if (ocrPackagesDraft.includes(pkg)) { onNotice?.("该包名已在列表里"); return; }
        setOcrPackagesDraft(prev => [...prev, pkg].slice(0, 20));
        setOcrPkgDraft("");
    };
    const removeOcrPackage = (pkg: string) => setOcrPackagesDraft(prev => prev.filter(p => p !== pkg));
    const saveOcrPackages = () => {
        updateSettings({ ocrScanPackages: ocrPackagesDraft });
        onNotice?.(`已保存 ${ocrPackagesDraft.length} 个 OCR 来源 App`);
    };

    const addOcrKeyword = () => {
        const kw = ocrKeywordDraft.trim();
        if (!kw) { onNotice?.("先填关键词再添加"); return; }
        if (ocrKeywordsDraft.includes(kw)) { onNotice?.("该关键词已在列表里"); return; }
        setOcrKeywordsDraft(prev => [...prev, kw].slice(0, 20));
        setOcrKeywordDraft("");
    };
    const removeOcrKeyword = (kw: string) => setOcrKeywordsDraft(prev => prev.filter(k => k !== kw));
    const saveOcrKeywords = () => {
        updateSettings({ ocrResultKeywords: ocrKeywordsDraft });
        onNotice?.(`已保存 ${ocrKeywordsDraft.length} 个识别关键词`);
    };

    const addPlace = () => {
        const name = placeDraft.name.trim();
        if (!name) { onNotice?.("先填地点名"); return; }
        if (placesDraft.some(p => p.name === name)) { onNotice?.("该地点已存在"); return; }
        setPlacesDraft(prev => [...prev, { name: name.slice(0, 40), lat: placeDraft.lat, lng: placeDraft.lng, radiusM: placeDraft.radiusM }].slice(0, 20));
    };
    const removePlace = (name: string) => setPlacesDraft(prev => prev.filter(p => p.name !== name));
    const savePlaces = () => {
        updateSettings({ whereaboutsPlaces: placesDraft });
        onNotice?.(`已保存 ${placesDraft.length} 个常用地点`);
    };

    const testHealth = () => {
        const result = invokeShellJson<Record<string, unknown>>(s =>
            (s.readGadgetbridgeHealth ? s.readGadgetbridgeHealth(settings.healthExportPath) : null));
        if (!result.ok) { onNotice?.(result.error ?? "健康数据读取失败"); return; }
        const data = result.data;
        const toNum = (v: unknown) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const snap: HuaweiHealthSnapshot = {
            status: String(data.status ?? "ok"),
            stepsToday: toNum(data.stepsToday),
            latestHeartRate: toNum(data.latestHeartRate),
            latestHeartRateAt: toNum(data.latestHeartRateAt),
            latestStress: toNum(data.latestStress),
            activeCaloriesToday: toNum(data.activeCaloriesToday),
            sleepMinutes: toNum(data.sleepMinutes),
            sleepStartedAt: toNum(data.sleepStartedAt),
            sleepWakeAt: toNum(data.sleepWakeAt),
            message: String(data.message ?? ""),
            updatedAt: Date.now(),
        };
        saveHuaweiHealthSnapshot(snap);
        setHealthSnapshot(snap);
        onNotice?.("健康快照已刷新（今日步数 / 心率 / 睡眠）");
    };

    const resetCompanionLatches = () => {
        updateSettings({
            companionLatched: {
                lastArrivedDate: "",
                lastLeftDate: "",
                lastPlaceDate: "",
                lastLowBatteryLevel: null,
                lastSleepDate: "",
            },
        });
        onNotice?.("陪伴提醒的防重复标记已清零，下次将重新提醒");
    };

    const handleCapabilityToggle = (value: boolean) => {
        const items = loadInternalCapabilities().map(item =>
            item.id === HUAWEI_SHELL_CAPABILITY_ID
                ? { ...item, enabled: value, mode: (value ? "auto" : "off") as typeof item.mode, updatedAt: Date.now() }
                : item);
        saveInternalCapabilities(items);
        setCapabilityOn(value);
        onNotice?.(value ? "已启用「华为手机」能力：角色可在对话里操控你的真实手机" : "已关闭「华为手机」能力");
    };

    const handleFloatingToggle = (value: boolean) => {
        const shell = getAndroidShell();
        if (!shell || typeof shell.setFloating !== "function") {
            onNotice?.("华为壳未连接，无法开关悬浮球");
            return;
        }
        shell.setFloating(value);
        setFloating(value);
        onNotice?.(value ? "已开启悬浮球（双击速聊）" : "已关闭悬浮球");
    };

    const addLockedPackage = () => {
        const pkg = newPackage.trim();
        if (!pkg) { onNotice?.("先填包名再添加"); return; }
        if (lockedDraft.includes(pkg)) { onNotice?.("该包名已在列表里"); return; }
        setLockedDraft(prev => [...prev, pkg].slice(0, 30));
        setNewPackage("");
    };

    const removeLockedPackage = (pkg: string) => setLockedDraft(prev => prev.filter(p => p !== pkg));

    const syncLockedToShell = () => {
        const result = pushLockedPackagesToShell(lockedDraft);
        if (!result.ok) { onNotice?.(result.error ?? "同步失败"); return; }
        updateSettings({ lockedPackages: lockedDraft });
        onNotice?.(`已同步 ${lockedDraft.length} 个门禁锁 App 到手机（列表存在设置里，角色工具可用）`);
    };

    const loadLockedFromShell = () => {
        const list = readLockedPackagesFromShell();
        setLockedDraft(list);
        updateSettings({ lockedPackages: list });
        onNotice?.(`已从手机读取 ${list.length} 个门禁锁 App`);
    };

    const runTest = async (label: string, fn: () => string | Promise<string>) => {
        setBusy(label);
        setTestOutput(null);
        try {
            const text = await fn();
            setTestOutput({ label, text, ok: true });
        } catch (err) {
            setTestOutput({ label, text: err instanceof Error ? err.message : String(err), ok: false });
        } finally {
            setBusy(null);
        }
    };

    const testStatus = () => runTest("查看手机状态", () => {
        const r = invokeShellJson<Record<string, unknown>>(s => (s.getStatus ? s.getStatus() : null));
        if (!r.ok) throw new Error(r.error);
        const d = r.data;
        const parts: string[] = [];
        if (typeof d.battery === "number") parts.push(`电量 ${d.battery}%`);
        if (typeof d.volume === "number") parts.push(`音量 ${d.volume}`);
        parts.push(d.network ? "网络已连接" : "网络未连接");
        parts.push(d.accessibility ? "无障碍已开启" : "无障碍未开启");
        parts.push(d.floating ? "悬浮球已开启" : "悬浮球未开启");
        if (typeof d.lockedApps === "number") parts.push(`门禁锁 ${d.lockedApps} 个`);
        return parts.join("，") || "（无状态数据）";
    });

    const testLocation = () => runTest("查询位置", () => {
        const r = invokeShellJson<Record<string, unknown>>(s => (s.getLocation ? s.getLocation() : null));
        if (!r.ok) throw new Error(r.error);
        return `纬度 ${Number(r.data.lat).toFixed(5)}，经度 ${Number(r.data.lng).toFixed(5)}`;
    });

    const testCurrentApp = () => runTest("查看当前应用", () => {
        const r = invokeShellJson<Record<string, unknown>>(s => (s.getCurrentApp ? s.getCurrentApp() : null));
        if (!r.ok) throw new Error(r.error);
        return String(r.data.currentApp ?? "当前没有前台应用（或无障碍未开启）");
    });

    const testNotifications = () => runTest("查看通知", () => {
        const r = invokeShellJson<Array<Record<string, unknown>>>(s => (s.getNotifications ? s.getNotifications(5) : null));
        if (!r.ok) throw new Error(r.error);
        const list = Array.isArray(r.data) ? r.data : [];
        if (list.length === 0) return "暂无通知（请先在 系统设置 → 通知使用权 开启）";
        return list.map((item, i) => `${i + 1}. [${item.pkg ?? ""}] ${item.title ?? ""} ${item.text ?? ""}`.trim()).join("\n");
    });

    const testLedger = () => runTest("同步账本", () => {
        const sync = syncHuaweiLedgerFromShell(30);
        setLedger(getHuaweiLedgerSummary());
        if (!sync.ok && sync.total === 0) throw new Error(sync.error ?? "同步失败");
        const entries = readHuaweiLedger(10, "all");
        if (entries.length === 0) return "账本暂无记录（需开启通知使用权，且发生过支付通知）";
        const lines = entries.map(e => {
            const label = e.source === "wechat" ? "微信" : e.source === "alipay" ? "支付宝" : "其他";
            return `[${label}] ¥${e.amount.toFixed(2)} ${e.merchant}${e.note ? `（${e.note}）` : ""}`;
        });
        return `${lines.join("\n")}\n\n账本共 ${sync.total} 笔（本次新增 ${sync.added} 笔）`;
    });

    /* ---------- 自定义快捷动作 ---------- */
    const HUAWEI_BUILTIN_TOOL_NAMES = new Set([
        "查看手机状态", "查询位置", "查看当前应用", "查看通知", "查看记账", "读取微信消息",
        "打开应用", "点击文字", "输入文字", "滑动屏幕", "按键操作", "专注模式", "定时息屏", "发送提醒",
        "查看设备详情", "调节音量", "调节亮度", "读取剪贴板", "写入剪贴板", "打开网页", "读取文件",
        "管理应用", "飞行模式",
        "语音转文字", "发起语音通话", "识别屏幕交易", "查询行踪足迹", "查看健康数据",
    ]);
    const [actions, setActions] = useState<HuaweiCustomAction[]>(() => loadHuaweiCustomActions());
    const [actionDraft, setActionDraft] = useState({
        name: "",
        type: "open_app" as HuaweiCustomActionType,
        description: "",
        packageName: "",
        title: "",
        content: "",
        openApp: "",
        statusKey: "battery" as HuaweiStatusKey,
        command: "",
    });

    const huaweiActionTypeLabel = (type: HuaweiCustomActionType): string => {
        switch (type) {
            case "open_app": return "打开应用";
            case "send_notification": return "发通知";
            case "read_status": return "读状态";
            case "shell": return "Shell 命令";
            default: return type;
        }
    };

    const addCustomAction = () => {
        const name = actionDraft.name.trim();
        if (!name) { onNotice?.("先填动作名（char 调用时用的工具名）"); return; }
        if (HUAWEI_BUILTIN_TOOL_NAMES.has(name)) { onNotice?.("与内置工具重名，换个名字"); return; }
        if (actions.some(a => a.name === name)) { onNotice?.("已有同名动作"); return; }
        if (actionDraft.type === "open_app" && !actionDraft.packageName.trim()) { onNotice?.("打开应用需填包名"); return; }
        if (actionDraft.type === "send_notification" && (!actionDraft.title.trim() || !actionDraft.content.trim())) { onNotice?.("发通知需填标题和内容"); return; }
        if (actionDraft.type === "shell" && !actionDraft.command.trim()) { onNotice?.("Shell 动作需填命令"); return; }
        const next: HuaweiCustomAction[] = [...actions, {
            id: `action_${Date.now().toString(36)}_${actions.length}`,
            name,
            type: actionDraft.type,
            description: actionDraft.description.trim(),
            packageName: actionDraft.type === "open_app" ? actionDraft.packageName.trim() : undefined,
            title: actionDraft.type === "send_notification" ? actionDraft.title.trim() : undefined,
            content: actionDraft.type === "send_notification" ? actionDraft.content.trim() : undefined,
            openApp: actionDraft.type === "send_notification" ? (actionDraft.openApp.trim() || undefined) : undefined,
            statusKey: actionDraft.type === "read_status" ? actionDraft.statusKey : undefined,
            command: actionDraft.type === "shell" ? actionDraft.command.trim() : undefined,
            enabled: true,
            createdAt: Date.now(),
        }];
        setActions(next);
        saveHuaweiCustomActions(next);
        setActionDraft({ name: "", type: "open_app", description: "", packageName: "", title: "", content: "", openApp: "", statusKey: "battery", command: "" });
        onNotice?.(`已登记自定义动作「${name}」：char 现在可以按名字直接调用`);
    };

    const toggleAction = (id: string) => {
        const next = actions.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a);
        setActions(next);
        saveHuaweiCustomActions(next);
    };

    const removeAction = (id: string) => {
        const target = actions.find(a => a.id === id);
        const next = actions.filter(a => a.id !== id);
        setActions(next);
        saveHuaweiCustomActions(next);
        onNotice?.(target ? `已删除自定义动作「${target.name}」` : "已删除");
    };

    /* ---------- 自动联动规则 ---------- */
    const WEEKDAY_LABELS = [
        { key: "mon", label: "一" }, { key: "tue", label: "二" }, { key: "wed", label: "三" },
        { key: "thu", label: "四" }, { key: "fri", label: "五" }, { key: "sat", label: "六" }, { key: "sun", label: "日" },
    ];
    const [rules, setRules] = useState<HuaweiTriggerRule[]>(() => loadHuaweiTriggerRules());
    const [ruleDraft, setRuleDraft] = useState({
        name: "",
        trigger: "notification" as HuaweiTriggerRuleTrigger,
        notifyPkg: "",
        notifyKeyword: "",
        time: "",
        days: [] as string[],
        action: "send_notification" as HuaweiTriggerRuleAction,
        title: "",
        content: "",
        openApp: "",
        actionPackageName: "",
    });

    const ruleSummary = (r: HuaweiTriggerRule): string => {
        const triggerText = r.trigger === "time"
            ? `每天 ${r.time ?? ""}${r.days && r.days.length > 0 ? `（${r.days.join("/")}）` : ""}`
            : r.notifyPkg === "payment" ? "收到微信/支付宝支付通知"
            : r.notifyPkg ? `收到 ${r.notifyPkg} 通知` : "收到任意通知";
        const actionText = r.action === "send_notification" ? `发提醒「${r.title ?? ""}」` : `打开应用 ${r.actionPackageName ?? ""}`;
        return `${triggerText} → ${actionText}`;
    };

    const toggleDay = (day: string) => {
        setRuleDraft(prev => ({
            ...prev,
            days: prev.days.includes(day) ? prev.days.filter(d => d !== day) : [...prev.days, day],
        }));
    };

    const addRule = () => {
        const name = ruleDraft.name.trim();
        if (!name) { onNotice?.("先填规则名"); return; }
        if (ruleDraft.trigger === "time" && !/^\d{2}:\d{2}$/.test(ruleDraft.time.trim())) { onNotice?.("定时触发需填时间（HH:MM，如 08:00）"); return; }
        if (ruleDraft.action === "send_notification" && (!ruleDraft.title.trim() || !ruleDraft.content.trim())) { onNotice?.("发通知提醒需填标题和内容"); return; }
        if (ruleDraft.action === "open_app" && !ruleDraft.actionPackageName.trim()) { onNotice?.("打开应用需填包名"); return; }
        const next: HuaweiTriggerRule[] = [...rules, {
            id: `rule_${Date.now().toString(36)}_${rules.length}`,
            name,
            enabled: true,
            trigger: ruleDraft.trigger,
            notifyPkg: ruleDraft.trigger === "notification" ? (ruleDraft.notifyPkg.trim() || undefined) : undefined,
            notifyKeyword: ruleDraft.trigger === "notification" ? (ruleDraft.notifyKeyword.trim() || undefined) : undefined,
            time: ruleDraft.trigger === "time" ? ruleDraft.time.trim() : undefined,
            days: ruleDraft.trigger === "time" ? (ruleDraft.days.length > 0 ? [...ruleDraft.days] : undefined) : undefined,
            action: ruleDraft.action,
            title: ruleDraft.action === "send_notification" ? ruleDraft.title.trim() : undefined,
            content: ruleDraft.action === "send_notification" ? ruleDraft.content.trim() : undefined,
            openApp: ruleDraft.action === "send_notification" ? (ruleDraft.openApp.trim() || undefined) : undefined,
            actionPackageName: ruleDraft.action === "open_app" ? ruleDraft.actionPackageName.trim() : undefined,
        }];
        setRules(next);
        saveHuaweiTriggerRules(next);
        setRuleDraft({ name: "", trigger: "notification", notifyPkg: "", notifyKeyword: "", time: "", days: [], action: "send_notification", title: "", content: "", openApp: "", actionPackageName: "" });
        onNotice?.(`已创建联动规则「${name}」，常驻检查会自动触发`);
    };

    const toggleRule = (id: string) => {
        const next = rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r);
        setRules(next);
        saveHuaweiTriggerRules(next);
    };

    const removeRule = (id: string) => {
        const target = rules.find(r => r.id === id);
        const next = rules.filter(r => r.id !== id);
        setRules(next);
        saveHuaweiTriggerRules(next);
        onNotice?.(target ? `已删除联动规则「${target.name}」` : "已删除");
    };

    const handleReset = () => {
        resetHuaweiShellSettings();
        setSettings(loadHuaweiShellSettings());
        setLockedDraft([]);
        onNotice?.("已恢复华为壳默认配置（门禁锁列表需重新同步到手机）");
    };

    const permChip = (ok: boolean | null, yes = "已开启", no = "未开启") => (
        <span className={`hw-chip ${ok === true ? "hw-chip-on" : ok === false ? "hw-chip-off" : "hw-chip-unknown"}`}>
            {ok === true ? yes : ok === false ? no : "未知"}
        </span>
    );

    return (
        <div className="hw-shell">
            {/* 连接状态 + 能力开关 */}
            <div className="hw-shell-card hw-shell-hero">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-hero-head">
                    <div className="hw-hero-icon"><Smartphone size={22} /></div>
                    <div className="hw-hero-copy">
                        <div className="hw-hero-title">华为壳 · 真实手机桥</div>
                        <div className="hw-hero-desc">
                            {shellAvailable
                                ? `已连接${shellVersion ? `（壳 v${shellVersion}）` : ""}：角色在对话里可以直接查看、操控你的真实华为手机`
                                : "未连接：请用华为壳 App 打开本站，网页侧检测到 window.AndroidShell 后自动生效"}
                        </div>
                    </div>
                    <span className={`hw-status-dot ${shellAvailable ? "hw-status-on" : "hw-status-off"}`} />
                </div>
                <div className="hw-toggle-row">
                    <div className="hw-toggle-copy">
                        <span className="hw-toggle-title">「华为手机」能力开关</span>
                        <span className="hw-toggle-desc">开启后角色在对话里能主动调用华为壳工具（可在工具箱 → 内置能力里改确认模式）</span>
                    </div>
                    <button
                        type="button"
                        className={`hw-switch ${capabilityOn ? "hw-switch-on" : ""}`}
                        role="switch"
                        aria-checked={capabilityOn}
                        onClick={() => handleCapabilityToggle(!capabilityOn)}
                    >
                        <span className="hw-switch-knob" />
                    </button>
                </div>
            </div>

            {/* 权限与状态 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title">权限与实时状态</div>
                <div className="hw-perm-grid">
                    <div className="hw-perm-item">
                        <span className="hw-perm-icon"><Wifi size={15} /></span>
                        <span className="hw-perm-label">无障碍服务</span>
                        {permChip(accessibility)}
                        <span className="hw-perm-hint">点击文字 / 输入 / 滑动 / 当前应用的基础</span>
                        {shellAvailable && (
                            <button type="button" className="hw-btn hw-btn-mini" onClick={() => getAndroidShell()?.openAppSettings?.()}>
                                去系统设置
                            </button>
                        )}
                    </div>
                    <div className="hw-perm-item">
                        <span className="hw-perm-icon"><Bell size={15} /></span>
                        <span className="hw-perm-label">通知使用权</span>
                        <span className="hw-chip hw-chip-unknown">需手动开启</span>
                        <span className="hw-perm-hint">通知 / 自动记账 / 读取微信消息的原料来源</span>
                        {shellAvailable && (
                            <button type="button" className="hw-btn hw-btn-mini" onClick={() => testNotifications()}>
                                检测
                            </button>
                        )}
                    </div>
                    <div className="hw-perm-item">
                        <span className="hw-perm-icon"><MapPin size={15} /></span>
                        <span className="hw-perm-label">位置权限</span>
                        <span className="hw-chip hw-chip-unknown">首次自动弹窗</span>
                        <span className="hw-perm-hint">查询位置 / 足迹 geofence 需要；未授权时工具会提示重试</span>
                        {shellAvailable && (
                            <button type="button" className="hw-btn hw-btn-mini" onClick={testLocation}>
                                检查
                            </button>
                        )}
                    </div>
                    <div className="hw-perm-item">
                        <span className="hw-perm-icon"><Zap size={15} /></span>
                        <span className="hw-perm-label">悬浮球</span>
                        {permChip(floating, "已开启", "已关闭")}
                        <span className="hw-perm-hint">双击速聊；壳被清理后重启会用到</span>
                        {shellAvailable && (
                            <button
                                type="button"
                                className="hw-btn hw-btn-mini"
                                onClick={() => handleFloatingToggle(!(floating === true))}
                            >
                                {floating === true ? "关闭" : "开启"}
                            </button>
                        )}
                    </div>
                    <div className="hw-perm-item">
                        <span className="hw-perm-icon"><Battery size={15} /></span>
                        <span className="hw-perm-label">电池优化</span>
                        <span className="hw-chip hw-chip-unknown">建议忽略</span>
                        <span className="hw-perm-hint">保活关键：忽略电池优化，后台连接不断</span>
                        {shellAvailable && (
                            <button type="button" className="hw-btn hw-btn-mini" onClick={() => getAndroidShell()?.requestIgnoreBatteryOptimization?.()}>
                                去设置
                            </button>
                        )}
                    </div>
                    <div className="hw-perm-item">
                        <span className="hw-perm-icon"><Lock size={15} /></span>
                        <span className="hw-perm-label">门禁锁 App</span>
                        <span className="hw-chip hw-chip-on">{settings.lockedPackages.length} 个</span>
                        <span className="hw-perm-hint">锁定的 App 会被拦回桌面；列表在下方维护</span>
                        {shellAvailable && (
                            <button type="button" className="hw-btn hw-btn-mini" onClick={loadLockedFromShell}>
                                读手机
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* 专注 / 息屏默认时长 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Timer size={16} /> 专注与息屏默认时长</div>
                <div className="hw-field-row hw-field-row-gap">
                    <div className="hw-field">
                        <label className="hw-field-label"><Moon size={13} /> 专注模式默认时长（分钟）</label>
                        <input
                            className="hw-input hw-input-num"
                            type="number"
                            min={1}
                            max={240}
                            value={settings.focusDefaultMinutes}
                            onChange={e => updateSettings({ focusDefaultMinutes: Math.round(Number(e.target.value) || 25) })}
                        />
                    </div>
                    <div className="hw-field">
                        <label className="hw-field-label"><Eye size={13} /> 定时息屏默认秒数</label>
                        <input
                            className="hw-input hw-input-num"
                            type="number"
                            min={5}
                            max={3600}
                            value={settings.screenBreakDefaultSeconds}
                            onChange={e => updateSettings({ screenBreakDefaultSeconds: Math.round(Number(e.target.value) || 60) })}
                        />
                    </div>
                </div>
            </div>

            {/* 门禁锁 App */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Lock size={16} /> 门禁锁 App（专注守护）</div>
                <div className="hw-field-row">
                    <input
                        className="hw-input"
                        value={newPackage}
                        onChange={e => setNewPackage(e.target.value)}
                        placeholder="应用包名，如 com.tencent.mm"
                        onKeyDown={e => { if (e.key === "Enter") addLockedPackage(); }}
                        spellCheck={false}
                    />
                    <button type="button" className="hw-btn hw-btn-ghost" onClick={addLockedPackage}>
                        <Plus size={14} /> 添加
                    </button>
                </div>
                <div className="hw-lock-list">
                    {lockedDraft.length === 0 && <span className="hw-field-hint">列表为空：解锁的手机可随意打开，锁定的会被拦回桌面</span>}
                    {lockedDraft.map(pkg => (
                        <span className="hw-lock-chip" key={pkg}>
                            {pkg}
                            <button type="button" className="hw-lock-remove" onClick={() => removeLockedPackage(pkg)} aria-label={`移除 ${pkg}`}>
                                <Trash2 size={12} />
                            </button>
                        </span>
                    ))}
                </div>
                <div className="hw-field-row">
                    <button type="button" className="hw-btn hw-btn-primary" onClick={syncLockedToShell} disabled={busy !== null}>
                        <Zap size={14} /> 同步到手机
                    </button>
                    <button type="button" className="hw-btn hw-btn-ghost" onClick={loadLockedFromShell} disabled={busy !== null}>
                        <RefreshCw size={14} /> 从手机读取
                    </button>
                    <span className="hw-field-hint">同步后角色可用「专注模式」锁定全机</span>
                </div>
            </div>

            {/* 通知 / 记账默认 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Receipt size={16} /> 通知与记账默认</div>
                <div className="hw-field-row hw-field-row-gap">
                    <div className="hw-field">
                        <label className="hw-field-label">查看通知默认条数</label>
                        <input
                            className="hw-input hw-input-num"
                            type="number"
                            min={1}
                            max={50}
                            value={settings.notificationDefaultLimit}
                            onChange={e => updateSettings({ notificationDefaultLimit: Math.round(Number(e.target.value) || 10) })}
                        />
                    </div>
                    <div className="hw-field">
                        <label className="hw-field-label">查看记账默认条数</label>
                        <input
                            className="hw-input hw-input-num"
                            type="number"
                            min={1}
                            max={100}
                            value={settings.paymentDefaultLimit}
                            onChange={e => updateSettings({ paymentDefaultLimit: Math.round(Number(e.target.value) || 20) })}
                        />
                    </div>
                    <div className="hw-field">
                        <label className="hw-field-label">记账默认来源</label>
                        <select
                            className="hw-select"
                            value={settings.paymentDefaultSource}
                            onChange={e => updateSettings({ paymentDefaultSource: e.target.value as HuaweiShellSettings["paymentDefaultSource"] })}
                        >
                            {PAYMENT_SOURCE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                        </select>
                    </div>
                </div>
            </div>

            {/* 自动记账账本 */}
            <div className="hw-shell-card hw-ledger-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Receipt size={16} /> 自动记账账本（单一数据源）</div>
                <div className="hw-ledger-stats">
                    <div className="hw-ledger-stat"><span className="hw-ledger-num">{ledger.total}</span><span className="hw-ledger-name">总笔数</span></div>
                    <div className="hw-ledger-stat"><span className="hw-ledger-num">{ledger.wechat}</span><span className="hw-ledger-name">微信</span></div>
                    <div className="hw-ledger-stat"><span className="hw-ledger-num">{ledger.alipay}</span><span className="hw-ledger-name">支付宝</span></div>
                    <div className="hw-ledger-stat"><span className="hw-ledger-num">{ledger.other}</span><span className="hw-ledger-name">其他</span></div>
                </div>
                <div className="hw-field-row">
                    <button type="button" className="hw-btn hw-btn-primary" onClick={testLedger} disabled={busy !== null}>
                        {busy === "同步账本" ? <Loader2 size={14} className="hw-spin" /> : <RefreshCw size={14} />}
                        拉取通知并落账
                    </button>
                    <span className="hw-field-hint">微信 / 支付宝按来源分开记；角色「查看记账」与记账应用都读这本账</span>
                </div>
            </div>

            {/* 自定义快捷动作 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Wand2 size={16} /> 自定义快捷动作（登记后 char 可直接调用）</div>
                <div className="hw-field">
                    <label className="hw-field-label">动作名（char 调用名）</label>
                    <input
                        className="hw-input"
                        value={actionDraft.name}
                        onChange={e => setActionDraft(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="如 打开微信"
                        spellCheck={false}
                    />
                </div>
                <div className="hw-field">
                    <label className="hw-field-label">动作类型</label>
                    <select className="hw-select" value={actionDraft.type} onChange={e => setActionDraft(prev => ({ ...prev, type: e.target.value as HuaweiCustomActionType }))}>
                        <option value="open_app">打开指定应用（包名）</option>
                        <option value="send_notification">给手机发一条通知（标题+内容）</option>
                        <option value="read_status">读取内置状态（电量/位置/当前应用等）</option>
                        <option value="shell">执行一段 shell 命令</option>
                    </select>
                </div>
                {actionDraft.type === "open_app" && (
                    <div className="hw-field">
                        <label className="hw-field-label">应用包名</label>
                        <input
                            className="hw-input"
                            value={actionDraft.packageName}
                            onChange={e => setActionDraft(prev => ({ ...prev, packageName: e.target.value }))}
                            placeholder="如 com.tencent.mm"
                            spellCheck={false}
                        />
                    </div>
                )}
                {actionDraft.type === "send_notification" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">提醒标题</label>
                            <input className="hw-input" value={actionDraft.title} onChange={e => setActionDraft(prev => ({ ...prev, title: e.target.value }))} placeholder="标题" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">提醒内容</label>
                            <input className="hw-input" value={actionDraft.content} onChange={e => setActionDraft(prev => ({ ...prev, content: e.target.value }))} placeholder="内容" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">点击后打开的应用包名（可选）</label>
                            <input className="hw-input" value={actionDraft.openApp} onChange={e => setActionDraft(prev => ({ ...prev, openApp: e.target.value }))} placeholder="如 com.tencent.mm" spellCheck={false} />
                        </div>
                    </>
                )}
                {actionDraft.type === "read_status" && (
                    <div className="hw-field">
                        <label className="hw-field-label">要读取的状态</label>
                        <select className="hw-select" value={actionDraft.statusKey} onChange={e => setActionDraft(prev => ({ ...prev, statusKey: e.target.value as HuaweiStatusKey }))}>
                            <option value="battery">电量</option>
                            <option value="volume">媒体音量</option>
                            <option value="network">网络连接</option>
                            <option value="accessibility">无障碍服务</option>
                            <option value="floating">悬浮球</option>
                            <option value="locked">门禁锁数量</option>
                            <option value="location">位置</option>
                            <option value="current_app">当前应用</option>
                        </select>
                    </div>
                )}
                {actionDraft.type === "shell" && (
                    <div className="hw-field">
                        <label className="hw-field-label">要执行的命令</label>
                        <input
                            className="hw-input"
                            value={actionDraft.command}
                            onChange={e => setActionDraft(prev => ({ ...prev, command: e.target.value }))}
                            placeholder="如 getprop ro.build.version.release"
                            spellCheck={false}
                        />
                    </div>
                )}
                <div className="hw-field">
                    <label className="hw-field-label">使用说明（告诉 char 什么时候用，可选）</label>
                    <input
                        className="hw-input"
                        value={actionDraft.description}
                        onChange={e => setActionDraft(prev => ({ ...prev, description: e.target.value }))}
                        placeholder="如 用户说「帮我开微信」时用"
                        spellCheck={false}
                    />
                </div>
                <div className="hw-field-row">
                    <button type="button" className="hw-btn hw-btn-primary" onClick={addCustomAction}>
                        <Plus size={14} /> 登记动作
                    </button>
                    <span className="hw-field-hint">登记后自动变成 char 工具；名字不能与内置工具重名</span>
                </div>
                {actions.length === 0 && <span className="hw-field-hint">还没有自定义动作。示例：登记「打开微信」→ char 说“打开微信”时直接执行</span>}
                {actions.map(a => (
                    <div className="hw-action-row" key={a.id}>
                        <div className="hw-action-copy">
                            <div className="hw-action-name">{a.name}</div>
                            <div className="hw-action-sub">{huaweiActionTypeLabel(a.type)}{a.description ? ` · ${a.description}` : ""}</div>
                        </div>
                        <button
                            type="button"
                            className={`hw-switch hw-switch-sm ${a.enabled ? "hw-switch-on" : ""}`}
                            role="switch"
                            aria-checked={a.enabled}
                            onClick={() => toggleAction(a.id)}
                        >
                            <span className="hw-switch-knob" />
                        </button>
                        <button type="button" className="hw-btn hw-btn-mini hw-btn-danger" onClick={() => removeAction(a.id)} aria-label={`删除 ${a.name}`}>
                            <Trash2 size={12} />
                        </button>
                    </div>
                ))}
            </div>

            {/* 自动联动规则 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Workflow size={16} /> 自动联动规则（收到通知 / 定时 → 自动动作）</div>
                <div className="hw-field">
                    <label className="hw-field-label">规则名</label>
                    <input
                        className="hw-input"
                        value={ruleDraft.name}
                        onChange={e => setRuleDraft(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="如 支付到账提醒"
                        spellCheck={false}
                    />
                </div>
                <div className="hw-field">
                    <label className="hw-field-label">触发方式</label>
                    <select className="hw-select" value={ruleDraft.trigger} onChange={e => setRuleDraft(prev => ({ ...prev, trigger: e.target.value as HuaweiTriggerRuleTrigger }))}>
                        <option value="notification">收到通知时</option>
                        <option value="time">到达时间点时</option>
                    </select>
                </div>
                {ruleDraft.trigger === "notification" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">来源（支付通知 = 微信/支付宝；留空 = 任意通知）</label>
                            <select className="hw-select" value={ruleDraft.notifyPkg} onChange={e => setRuleDraft(prev => ({ ...prev, notifyPkg: e.target.value }))}>
                                <option value="">任意来源</option>
                                <option value="payment">微信/支付宝支付通知</option>
                                <option value="com.tencent.mm">微信</option>
                                <option value="com.eg.android.AlipayGphone">支付宝</option>
                            </select>
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">通知关键词（可选）</label>
                            <input
                                className="hw-input"
                                value={ruleDraft.notifyKeyword}
                                onChange={e => setRuleDraft(prev => ({ ...prev, notifyKeyword: e.target.value }))}
                                placeholder="如 到账"
                                spellCheck={false}
                            />
                        </div>
                    </>
                )}
                {ruleDraft.trigger === "time" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">触发时间（HH:MM）</label>
                            <input
                                className="hw-input"
                                value={ruleDraft.time}
                                onChange={e => setRuleDraft(prev => ({ ...prev, time: e.target.value }))}
                                placeholder="如 08:00"
                                spellCheck={false}
                            />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">星期（不选 = 每天）</label>
                            <div className="hw-chip-row">
                                {WEEKDAY_LABELS.map(({ key, label }) => (
                                    <button
                                        type="button"
                                        key={key}
                                        className={`hw-chip ${ruleDraft.days.includes(key) ? "hw-chip-on" : ""}`}
                                        onClick={() => toggleDay(key)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </>
                )}
                <div className="hw-field">
                    <label className="hw-field-label">触发后执行</label>
                    <select className="hw-select" value={ruleDraft.action} onChange={e => setRuleDraft(prev => ({ ...prev, action: e.target.value as HuaweiTriggerRuleAction }))}>
                        <option value="send_notification">发通知提醒</option>
                        <option value="open_app">打开应用</option>
                    </select>
                </div>
                {ruleDraft.action === "send_notification" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">提醒标题</label>
                            <input className="hw-input" value={ruleDraft.title} onChange={e => setRuleDraft(prev => ({ ...prev, title: e.target.value }))} placeholder="标题" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">提醒内容</label>
                            <input className="hw-input" value={ruleDraft.content} onChange={e => setRuleDraft(prev => ({ ...prev, content: e.target.value }))} placeholder="内容" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">点击后打开的应用包名（可选）</label>
                            <input className="hw-input" value={ruleDraft.openApp} onChange={e => setRuleDraft(prev => ({ ...prev, openApp: e.target.value }))} placeholder="如 com.tencent.mm" spellCheck={false} />
                        </div>
                    </>
                )}
                {ruleDraft.action === "open_app" && (
                    <div className="hw-field">
                        <label className="hw-field-label">应用包名</label>
                        <input className="hw-input" value={ruleDraft.actionPackageName} onChange={e => setRuleDraft(prev => ({ ...prev, actionPackageName: e.target.value }))} placeholder="如 com.tencent.mm" spellCheck={false} />
                    </div>
                )}
                <div className="hw-field-row">
                    <button type="button" className="hw-btn hw-btn-primary" onClick={addRule}>
                        <Plus size={14} /> 创建规则
                    </button>
                    <span className="hw-field-hint">页面开着时常驻检查，命中自动执行</span>
                </div>
                {rules.length === 0 && <span className="hw-field-hint">还没有联动规则。示例：收到微信支付通知 → 发提醒「已到账」</span>}
                {rules.map(r => (
                    <div className="hw-action-row" key={r.id}>
                        <div className="hw-action-copy">
                            <div className="hw-action-name">{r.name}</div>
                            <div className="hw-action-sub">{ruleSummary(r)}{r.triggerCount ? ` · 已触发 ${r.triggerCount} 次` : ""}</div>
                        </div>
                        <button
                            type="button"
                            className={`hw-switch hw-switch-sm ${r.enabled ? "hw-switch-on" : ""}`}
                            role="switch"
                            aria-checked={r.enabled}
                            onClick={() => toggleRule(r.id)}
                        >
                            <span className="hw-switch-knob" />
                        </button>
                        <button type="button" className="hw-btn hw-btn-mini hw-btn-danger" onClick={() => removeRule(r.id)} aria-label={`删除 ${r.name}`}>
                            <Trash2 size={12} />
                        </button>
                    </div>
                ))}
                <div className="hw-field">
                    <label className="hw-field-label">规则检查间隔（秒，10-300）</label>
                    <input
                        className="hw-input hw-input-num"
                        type="number"
                        min={10}
                        max={300}
                        value={settings.ruleCheckIntervalSec}
                        onChange={e => updateSettings({ ruleCheckIntervalSec: Math.round(Number(e.target.value) || 30) })}
                    />
                </div>
            </div>

            {/* 权限层级（照搬 Operit 五级体系，逐级可配） */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><ShieldCheck size={16} /> 权限层级（照搬 Operit 五级，逐级可配）</div>
                <div className="hw-field-row">
                    <button type="button" className="hw-btn hw-btn-mini" onClick={testPermissionStatus} disabled={busy !== null}>
                        {busy === "权限检测" ? <Loader2 size={14} className="hw-spin" /> : <ShieldCheck size={14} />}
                        检测全部权限状态
                    </button>
                    <span className="hw-field-hint">低层默认开、高层默认关；关闭的层级对应工具会被拦截并提示去开启</span>
                </div>
                {permStatus && <pre className="hw-perm-pre">{permStatus}</pre>}
                {HUAWEI_PERMISSION_LEVELS.map(level => (
                    <div className="hw-field" key={level.key}>
                        <label className="hw-field-label hw-toggle-line">
                            <input
                                type="checkbox"
                                className="hw-check"
                                checked={settings.permissionLevels[level.key]}
                                onChange={e => updateSettings({
                                    permissionLevels: { ...settings.permissionLevels, [level.key]: e.target.checked },
                                })}
                            />
                            {level.label}（{settings.permissionLevels[level.key] ? "已开启" : "已关闭"}）
                        </label>
                        <span className="hw-field-hint">{level.desc}</span>
                        <span className="hw-field-hint">风险：{level.risk}</span>
                        <span className="hw-field-hint">获取：{level.steps}</span>
                        {shellAvailable && level.setting && (
                            <button type="button" className="hw-btn hw-btn-mini" onClick={() => getAndroidShell()?.openPermissionSettings?.(level.setting)}>
                                去授权
                            </button>
                        )}
                    </div>
                ))}
                <div className="hw-field">
                    <label className="hw-field-label">root 检测 su 命令（鸿蒙难拿：能开则开；未 root 可保持 Root 级关闭）</label>
                    <input
                        className="hw-input"
                        value={settings.rootSuCommand}
                        onChange={e => updateSettings({ rootSuCommand: e.target.value })}
                        placeholder="su"
                        spellCheck={false}
                    />
                </div>
            </div>

            {/* 语音能力 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Mic size={16} /> 语音能力（STT + 唤醒 + 来电铃声）</div>
                <label className="hw-field-label hw-toggle-line">
                    <input type="checkbox" className="hw-check" checked={settings.voiceEnabled} onChange={e => updateSettings({ voiceEnabled: e.target.checked })} />
                    启用语音能力（通话免提直说 / 输入框语音）
                </label>
                <div className="hw-field">
                    <label className="hw-field-label">语音输入模式</label>
                    <select className="hw-select" value={settings.sttMode} onChange={e => updateSettings({ sttMode: e.target.value as HuaweiShellSettings["sttMode"] })}>
                        <option value="system">系统识别（SpeechRecognizer，免配置）</option>
                        <option value="online">在线接口（填地址与 Key）</option>
                        <option value="cloud">float 云端转写（需另行配置云端）</option>
                    </select>
                </div>
                {settings.sttMode === "online" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">在线 STT 接口地址</label>
                            <input className="hw-input" value={settings.sttOnlineUrl} onChange={e => updateSettings({ sttOnlineUrl: e.target.value })} placeholder="https://…/v1/audio/transcriptions" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">API Key</label>
                            <input className="hw-input" value={settings.sttOnlineKey} onChange={e => updateSettings({ sttOnlineKey: e.target.value })} placeholder="sk-…" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">模型名</label>
                            <input className="hw-input" value={settings.sttOnlineModel} onChange={e => updateSettings({ sttOnlineModel: e.target.value })} placeholder="whisper-1" spellCheck={false} />
                        </div>
                    </>
                )}
                <label className="hw-field-label hw-toggle-line">
                    <input type="checkbox" className="hw-check" checked={settings.wakeWordEnabled} onChange={e => updateSettings({ wakeWordEnabled: e.target.checked })} />
                    常驻语音唤醒（小艺式，默认关；开启需常驻麦克风）
                </label>
                {settings.wakeWordEnabled && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">唤醒词（3-8 字）</label>
                            <input className="hw-input" value={settings.wakeWordText} onChange={e => updateSettings({ wakeWordText: e.target.value })} placeholder="小浮小浮" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">唤醒检测模式</label>
                            <select className="hw-select" value={settings.wakeWordMode} onChange={e => updateSettings({ wakeWordMode: e.target.value as HuaweiShellSettings["wakeWordMode"] })}>
                                <option value="system">系统识别（识别文本含唤醒词）</option>
                                <option value="on_device">端上模板（VAD+MFCC+DTW，可登记模板）</option>
                            </select>
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">唤醒后动作</label>
                            <select className="hw-select" value={settings.wakeWordAction} onChange={e => updateSettings({ wakeWordAction: e.target.value as HuaweiShellSettings["wakeWordAction"] })}>
                                <option value="floating">打开悬浮球速聊</option>
                                <option value="chat">进入对话</option>
                            </select>
                        </div>
                    </>
                )}
                <label className="hw-field-label hw-toggle-line">
                    <input type="checkbox" className="hw-check" checked={settings.callRingEnabled} onChange={e => updateSettings({ callRingEnabled: e.target.checked })} />
                    char 主动来电响铃+震动（微信式提醒）
                </label>
                <div className="hw-field">
                    <label className="hw-field-label">响铃超时（秒）</label>
                    <input className="hw-input hw-input-num" type="number" min={5} max={120} value={settings.callRingTimeoutSec} onChange={e => updateSettings({ callRingTimeoutSec: Math.round(Number(e.target.value) || 30) })} />
                </div>
            </div>

            {/* OCR 记账兜底 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><ScanLine size={16} /> OCR 记账兜底（默认关，用户手动开启）</div>
                <label className="hw-field-label hw-toggle-line">
                    <input type="checkbox" className="hw-check" checked={settings.ocrEnabled} onChange={e => updateSettings({ ocrEnabled: e.target.checked })} />
                    启用：前台为支付类 App 时自动截屏识别交易并入账
                </label>
                {settings.ocrEnabled && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">识别引擎</label>
                            <select className="hw-select" value={settings.ocrEngine} onChange={e => updateSettings({ ocrEngine: e.target.value as HuaweiShellSettings["ocrEngine"] })}>
                                <option value="mlkit">本机识别（ML Kit，免配置）</option>
                                <option value="online">在线接口（填地址与 Key）</option>
                                <option value="web">回传网页（需视觉模型处理）</option>
                            </select>
                        </div>
                        {settings.ocrEngine === "online" && (
                            <>
                                <div className="hw-field">
                                    <label className="hw-field-label">在线 OCR 接口地址</label>
                                    <input className="hw-input" value={settings.ocrOnlineUrl} onChange={e => updateSettings({ ocrOnlineUrl: e.target.value })} placeholder="https://…" spellCheck={false} />
                                </div>
                                <div className="hw-field">
                                    <label className="hw-field-label">API Key</label>
                                    <input className="hw-input" value={settings.ocrOnlineKey} onChange={e => updateSettings({ ocrOnlineKey: e.target.value })} placeholder="sk-…" spellCheck={false} />
                                </div>
                            </>
                        )}
                        <div className="hw-field">
                            <label className="hw-field-label">金额匹配正则</label>
                            <input className="hw-input" value={settings.ocrAmountRegex} onChange={e => updateSettings({ ocrAmountRegex: e.target.value })} spellCheck={false} />
                        </div>
                        <label className="hw-field-label hw-toggle-line">
                            <input type="checkbox" className="hw-check" checked={settings.ocrConfirmRequired} onChange={e => updateSettings({ ocrConfirmRequired: e.target.checked })} />
                            识别结果需人工确认（默认开，避免误记）
                        </label>
                        <div className="hw-field">
                            <label className="hw-field-label">去重窗口（分钟）</label>
                            <input className="hw-input hw-input-num" type="number" min={1} max={1440} value={settings.ocrDedupeWindowMin} onChange={e => updateSettings({ ocrDedupeWindowMin: Math.round(Number(e.target.value) || 10) })} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">扫描间隔（秒）</label>
                            <input className="hw-input hw-input-num" type="number" min={10} max={600} value={settings.ocrScanIntervalSec} onChange={e => updateSettings({ ocrScanIntervalSec: Math.round(Number(e.target.value) || 15) })} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">OCR 监听来源 App（前台在此列表时自动识别）</label>
                            <div className="hw-chip-row">
                                {ocrPackagesDraft.map(pkg => (
                                    <span className="hw-chip hw-chip-on" key={pkg}>
                                        {pkg}
                                        <button type="button" className="hw-chip-x" onClick={() => removeOcrPackage(pkg)} aria-label={`删除 ${pkg}`}>×</button>
                                    </span>
                                ))}
                            </div>
                            <div className="hw-field-row">
                                <input className="hw-input" value={ocrPkgDraft} onChange={e => setOcrPkgDraft(e.target.value)} placeholder="com.tencent.mm" spellCheck={false} />
                                <button type="button" className="hw-btn hw-btn-mini" onClick={addOcrPackage}><Plus size={14} /> 添加</button>
                                <button type="button" className="hw-btn hw-btn-mini" onClick={saveOcrPackages}><RefreshCw size={14} /> 保存列表</button>
                            </div>
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">交易结果关键词</label>
                            <div className="hw-chip-row">
                                {ocrKeywordsDraft.map(kw => (
                                    <span className="hw-chip hw-chip-on" key={kw}>
                                        {kw}
                                        <button type="button" className="hw-chip-x" onClick={() => removeOcrKeyword(kw)} aria-label={`删除 ${kw}`}>×</button>
                                    </span>
                                ))}
                            </div>
                            <div className="hw-field-row">
                                <input className="hw-input" value={ocrKeywordDraft} onChange={e => setOcrKeywordDraft(e.target.value)} placeholder="支付成功" spellCheck={false} />
                                <button type="button" className="hw-btn hw-btn-mini" onClick={addOcrKeyword}><Plus size={14} /> 添加</button>
                                <button type="button" className="hw-btn hw-btn-mini" onClick={saveOcrKeywords}><RefreshCw size={14} /> 保存列表</button>
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* 语义行踪与足迹 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Footprints size={16} /> 语义行踪与足迹</div>
                <label className="hw-field-label hw-toggle-line">
                    <input type="checkbox" className="hw-check" checked={settings.whereaboutsEnabled} onChange={e => updateSettings({ whereaboutsEnabled: e.target.checked })} />
                    记录行踪足迹（char 可查询「我最近去过哪」）
                </label>
                {settings.whereaboutsEnabled && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">对外隐私模式</label>
                            <select className="hw-select" value={settings.whereaboutsPrivacyMode} onChange={e => updateSettings({ whereaboutsPrivacyMode: e.target.value as HuaweiShellSettings["whereaboutsPrivacyMode"] })}>
                                <option value="semantic">语义化（家/学校/商场，不暴露坐标）</option>
                                <option value="diagnostic">含坐标（自己排查用）</option>
                                <option value="off">不记录</option>
                            </select>
                        </div>
                        <div className="hw-field-row hw-field-row-gap">
                            <div className="hw-field">
                                <label className="hw-field-label">家：纬度</label>
                                <input className="hw-input hw-input-num" type="number" step="any" value={settings.whereaboutsHomeLat ?? ""} onChange={e => updateSettings({ whereaboutsHomeLat: e.target.value === "" ? null : Number(e.target.value) })} />
                            </div>
                            <div className="hw-field">
                                <label className="hw-field-label">家：经度</label>
                                <input className="hw-input hw-input-num" type="number" step="any" value={settings.whereaboutsHomeLng ?? ""} onChange={e => updateSettings({ whereaboutsHomeLng: e.target.value === "" ? null : Number(e.target.value) })} />
                            </div>
                            <div className="hw-field">
                                <label className="hw-field-label">围栏半径（米）</label>
                                <input className="hw-input hw-input-num" type="number" min={50} max={2000} value={settings.whereaboutsGeofenceRadiusM} onChange={e => updateSettings({ whereaboutsGeofenceRadiusM: Math.round(Number(e.target.value) || 150) })} />
                            </div>
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">常用地点（到达自动记足迹）</label>
                            <div className="hw-chip-row">
                                {placesDraft.map(p => (
                                    <span className="hw-chip hw-chip-on" key={p.name}>
                                        {p.name} {p.radiusM}m
                                        <button type="button" className="hw-chip-x" onClick={() => removePlace(p.name)} aria-label={`删除 ${p.name}`}>×</button>
                                    </span>
                                ))}
                            </div>
                            <div className="hw-field-row hw-field-row-gap">
                                <input className="hw-input" value={placeDraft.name} onChange={e => setPlaceDraft(prev => ({ ...prev, name: e.target.value }))} placeholder="地点名（如 学校）" spellCheck={false} />
                                <input className="hw-input hw-input-num" type="number" step="any" value={placeDraft.lat} onChange={e => setPlaceDraft(prev => ({ ...prev, lat: Number(e.target.value) }))} placeholder="纬度" />
                                <input className="hw-input hw-input-num" type="number" step="any" value={placeDraft.lng} onChange={e => setPlaceDraft(prev => ({ ...prev, lng: Number(e.target.value) }))} placeholder="经度" />
                                <input className="hw-input hw-input-num" type="number" min={50} max={2000} value={placeDraft.radiusM} onChange={e => setPlaceDraft(prev => ({ ...prev, radiusM: Math.round(Number(e.target.value) || 150) }))} placeholder="半径m" />
                            </div>
                            <div className="hw-field-row">
                                <button type="button" className="hw-btn hw-btn-mini" onClick={addPlace}><Plus size={14} /> 添加</button>
                                <button type="button" className="hw-btn hw-btn-mini" onClick={savePlaces}><RefreshCw size={14} /> 保存地点</button>
                            </div>
                        </div>
                        <div className="hw-field-row hw-field-row-gap">
                            <div className="hw-field">
                                <label className="hw-field-label">退出迟滞（米）</label>
                                <input className="hw-input hw-input-num" type="number" min={10} max={1000} value={settings.whereaboutsExitHysteresisM} onChange={e => updateSettings({ whereaboutsExitHysteresisM: Math.round(Number(e.target.value) || 60) })} />
                            </div>
                            <div className="hw-field">
                                <label className="hw-field-label">保留天数</label>
                                <input className="hw-input hw-input-num" type="number" min={1} max={365} value={settings.whereaboutsRetentionDays} onChange={e => updateSettings({ whereaboutsRetentionDays: Math.round(Number(e.target.value) || 30) })} />
                            </div>
                            <div className="hw-field">
                                <label className="hw-field-label">扫描间隔（秒）</label>
                                <input className="hw-input hw-input-num" type="number" min={60} max={3600} value={settings.whereaboutsScanIntervalSec} onChange={e => updateSettings({ whereaboutsScanIntervalSec: Math.round(Number(e.target.value) || 300) })} />
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* 穿戴健康 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><HeartPulse size={16} /> 穿戴健康（Gadgetbridge 导出，默认关）</div>
                <label className="hw-field-label hw-toggle-line">
                    <input type="checkbox" className="hw-check" checked={settings.healthEnabled} onChange={e => updateSettings({ healthEnabled: e.target.checked })} />
                    启用健康快照刷新（char 可查步数/心率/睡眠）
                </label>
                {settings.healthEnabled && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">数据源</label>
                            <select className="hw-select" value={settings.healthSource} onChange={e => updateSettings({ healthSource: e.target.value as HuaweiShellSettings["healthSource"] })}>
                                <option value="gadgetbridge_sqlite">Gadgetbridge 导出库（原生直读）</option>
                                <option value="json">JSON 快照</option>
                                <option value="off">关闭</option>
                            </select>
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">导出库/快照路径</label>
                            <input className="hw-input" value={settings.healthExportPath} onChange={e => updateSettings({ healthExportPath: e.target.value })} placeholder="如 /storage/emulated/0/…/gadgetbridge.db" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">刷新间隔（秒）</label>
                            <input className="hw-input hw-input-num" type="number" min={60} max={86400} value={settings.healthRefreshIntervalSec} onChange={e => updateSettings({ healthRefreshIntervalSec: Math.round(Number(e.target.value) || 600) })} />
                        </div>
                        <div className="hw-field-row">
                            <button type="button" className="hw-btn hw-btn-mini" onClick={testHealth} disabled={busy !== null}>
                                {busy === "健康数据" ? <Loader2 size={14} className="hw-spin" /> : <HeartPulse size={14} />}
                                立即刷新快照
                            </button>
                        </div>
                        {healthSnapshot && (
                            <pre className="hw-perm-pre">{JSON.stringify(healthSnapshot, null, 2)}</pre>
                        )}
                    </>
                )}
            </div>

            {/* 陪伴推送强化 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><BellRing size={16} /> 陪伴推送强化（默认关）</div>
                <label className="hw-field-label hw-toggle-line">
                    <input type="checkbox" className="hw-check" checked={settings.companionEnabled} onChange={e => updateSettings({ companionEnabled: e.target.checked })} />
                    按陪伴逻辑主动推送关心/提醒（走华为壳本地通知）
                </label>
                {settings.companionEnabled && (
                    <>
                        <div className="hw-field-row hw-field-row-gap">
                            <label className="hw-field-label hw-toggle-line">
                                <input type="checkbox" className="hw-check" checked={settings.companionLocationArrived} onChange={e => updateSettings({ companionLocationArrived: e.target.checked })} />
                                到家提醒
                            </label>
                            <label className="hw-field-label hw-toggle-line">
                                <input type="checkbox" className="hw-check" checked={settings.companionLocationLeft} onChange={e => updateSettings({ companionLocationLeft: e.target.checked })} />
                                出门提醒
                            </label>
                            <label className="hw-field-label hw-toggle-line">
                                <input type="checkbox" className="hw-check" checked={settings.companionLocationPlace} onChange={e => updateSettings({ companionLocationPlace: e.target.checked })} />
                                到达地点提醒
                            </label>
                        </div>
                        <div className="hw-field-row hw-field-row-gap">
                            <label className="hw-field-label hw-toggle-line">
                                <input type="checkbox" className="hw-check" checked={settings.companionLowBattery} onChange={e => updateSettings({ companionLowBattery: e.target.checked })} />
                                低电量提醒
                            </label>
                            <div className="hw-field">
                                <label className="hw-field-label">低电量阈值（%）</label>
                                <input className="hw-input hw-input-num" type="number" min={5} max={50} value={settings.companionLowBatteryThreshold} onChange={e => updateSettings({ companionLowBatteryThreshold: Math.round(Number(e.target.value) || 20) })} />
                            </div>
                            <label className="hw-field-label hw-toggle-line">
                                <input type="checkbox" className="hw-check" checked={settings.companionSleepShort} onChange={e => updateSettings({ companionSleepShort: e.target.checked })} />
                                短睡眠提醒
                            </label>
                            <div className="hw-field">
                                <label className="hw-field-label">睡眠阈值（分钟）</label>
                                <input className="hw-input hw-input-num" type="number" min={60} max={720} value={settings.companionSleepThresholdMinutes} onChange={e => updateSettings({ companionSleepThresholdMinutes: Math.round(Number(e.target.value) || 420) })} />
                            </div>
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">推送标题</label>
                            <input className="hw-input" value={settings.companionTitle} onChange={e => updateSettings({ companionTitle: e.target.value })} placeholder="小浮" spellCheck={false} />
                        </div>
                        {(Object.keys(settings.companionTemplates) as Array<keyof typeof settings.companionTemplates>).map(key => (
                            <div className="hw-field" key={key}>
                                <label className="hw-field-label">{COMPANION_TEMPLATE_LABELS[key]}</label>
                                <input className="hw-input" value={settings.companionTemplates[key]} onChange={e => updateSettings({ companionTemplates: { ...settings.companionTemplates, [key]: e.target.value } })} spellCheck={false} />
                            </div>
                        ))}
                        <div className="hw-field-row">
                            <button type="button" className="hw-btn hw-btn-mini" onClick={resetCompanionLatches}>
                                <RefreshCw size={14} /> 清零防重复标记（重新提醒一轮）
                            </button>
                            <span className="hw-field-hint">每个事件一天只提醒一次，跨线才喊</span>
                        </div>
                    </>
                )}
            </div>

            {/* 快速测试 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Zap size={16} /> 快速测试（直接调用手机）</div>
                <div className="hw-btn-grid">
                    <button type="button" className="hw-btn" onClick={testStatus} disabled={busy !== null}>
                        {busy === "查看手机状态" ? <Loader2 size={14} className="hw-spin" /> : <Battery size={14} />}
                        状态
                    </button>
                    <button type="button" className="hw-btn" onClick={testCurrentApp} disabled={busy !== null}>
                        {busy === "查看当前应用" ? <Loader2 size={14} className="hw-spin" /> : <Smartphone size={14} />}
                        当前应用
                    </button>
                    <button type="button" className="hw-btn" onClick={testLocation} disabled={busy !== null}>
                        {busy === "查询位置" ? <Loader2 size={14} className="hw-spin" /> : <MapPin size={14} />}
                        位置
                    </button>
                    <button type="button" className="hw-btn" onClick={testNotifications} disabled={busy !== null}>
                        {busy === "查看通知" ? <Loader2 size={14} className="hw-spin" /> : <Bell size={14} />}
                        通知
                    </button>
                    <button type="button" className="hw-btn" onClick={testLedger} disabled={busy !== null}>
                        {busy === "同步账本" ? <Loader2 size={14} className="hw-spin" /> : <Volume2 size={14} />}
                        记账
                    </button>
                </div>
                {testOutput && (
                    <div className={`hw-test-output ${testOutput.ok ? "hw-test-ok" : "hw-test-err"}`}>
                        <div className="hw-test-label">{testOutput.label}</div>
                        <pre className="hw-test-text">{testOutput.text}</pre>
                    </div>
                )}
            </div>

            {/* 恢复默认 */}
            <div className="hw-shell-card hw-shell-foot">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-field-row">
                    <button type="button" className="hw-btn hw-btn-danger" onClick={handleReset}>
                        <RefreshCw size={14} /> 恢复默认配置
                    </button>
                    <span className="hw-field-hint">仅重置本页配置，不动你的手机数据</span>
                </div>
            </div>
        </div>
    );
}
