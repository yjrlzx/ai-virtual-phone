"use client";

/** 华为壳自动联动规则引擎：检查通知/定时触发条件并执行动作。
 *  由 HuaweiTriggerRulesScheduler（全局常驻组件）周期调用；
 *  规则、触发条件、动作与检查间隔全部在 设置 → 华为壳 界面可配，代码不写死。 */

import { getAndroidShell, invokeShellJson, loadHuaweiCustomActions, loadHuaweiTriggerRules, saveHuaweiTriggerRules, loadHuaweiShellSettings, appendHuaweiBridgeEvent, interpolateHuaweiTemplate } from "./storage";
import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { ALIPAY_PACKAGE, WECHAT_PACKAGE } from "./types";
import type { HuaweiCustomAction, HuaweiTriggerRule, HuaweiCustomActionType, HuaweiStatusKey } from "./types";

/** OCR 手动任务键：设置页/工具触发「识别屏幕交易」时登记，OCR 结果回传后按登记执行入账。 */
const HUAWEI_OCR_TASK_KEY = "ai_phone_huawei_ocr_task_v1";
registerKvMigration(HUAWEI_OCR_TASK_KEY);

const HUAWEI_WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** 定时类规则每天最多触发一次：距上次触发 12 小时内不再重复。 */
const TIME_RULE_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * 检查一次所有已启用的联动规则并执行命中的动作。
 * 返回本次实际触发条数；无规则 / 壳未连接时直接返回 0。
 */
export function checkHuaweiTriggerRules(): { triggered: number } {
    const settings = loadHuaweiShellSettings();
    if (!settings.bridgeEnabled) return { triggered: 0 };
    const rules = loadHuaweiTriggerRules();
    const enabled = rules.filter(rule => rule.enabled);
    if (enabled.length === 0) return { triggered: 0 };
    if (!getAndroidShell()) return { triggered: 0 };
    const now = Date.now();
    let triggered = 0;
    let changed = false;
    for (const rule of enabled) {
        // 通知类规则返回命中的那条通知（定时类为 null）；同时推进水位线
        const matched = rule.trigger === "time" ? null : notificationRuleShouldFire(rule);
        const shouldFire = rule.trigger === "time" ? timeRuleShouldFire(rule, now) : matched !== null;
        if (!shouldFire) continue;
        const result = fireHuaweiRuleAction(rule, matched);
        appendHuaweiBridgeEvent({ kind: "rule", title: rule.name, detail: result.detail, ok: result.ok });
        if (!result.ok) continue;
        triggered++;
        rule.lastTriggeredAt = now;
        rule.triggerCount = (rule.triggerCount || 0) + 1;
        changed = true;
        // 开启广播时，把命中通知信号派发给订阅 huawei.bridge.data 的自定义 APP
        if (settings.bridgeBroadcast && typeof window !== "undefined" && matched) {
            try {
                window.dispatchEvent(new CustomEvent("huawei.bridge.data", {
                    detail: {
                        type: "notification",
                        payload: `${matched.title ?? ""} ${matched.text ?? ""}`.trim(),
                        rule: rule.name,
                        at: Date.now(),
                    },
                }));
            } catch { /* 广播失败不阻塞联动 */ }
        }
    }
    if (changed) saveHuaweiTriggerRules(rules);
    return { triggered };
}

/** 定时规则：HH:MM 命中 + 星期匹配 + 当天未触发过。 */
function timeRuleShouldFire(rule: HuaweiTriggerRule, now: number): boolean {
    if (!rule.time || !/^\d{2}:\d{2}$/.test(rule.time)) return false;
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, "0");
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (hhmm !== rule.time) return false;
    if (rule.days && rule.days.length > 0) {
        if (!rule.days.includes(HUAWEI_WEEKDAY_KEYS[d.getDay()])) return false;
    }
    if (rule.lastTriggeredAt && now - rule.lastTriggeredAt < TIME_RULE_COOLDOWN_MS) return false;
    return true;
}

/** 通知规则：只看比 lastSeenTs 更新的通知，命中（来源 + 关键词）时返回那条通知，否则 null。 */
function notificationRuleShouldFire(rule: HuaweiTriggerRule): Record<string, unknown> | null {
    const result = invokeShellJson<Array<Record<string, unknown>>>(shell => (shell.getNotifications ? shell.getNotifications(30) : null));
    if (!result.ok) return null;
    const list = Array.isArray(result.data) ? result.data : [];
    if (list.length === 0) return null;
    const lastSeen = rule.lastSeenTs || 0;
    let maxTs = lastSeen;
    for (const item of list) {
        const ts = Number(item.ts);
        if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
    }
    if (maxTs <= lastSeen) return null;
    const isPayment = rule.notifyPkg === "payment";
    let matched: Record<string, unknown> | null = null;
    for (const item of list) {
        if (Number(item.ts) <= lastSeen) continue;
        if (isPayment) {
            const pkg = String(item.pkg ?? "");
            if (pkg !== WECHAT_PACKAGE && pkg !== ALIPAY_PACKAGE) continue;
        } else if (rule.notifyPkg) {
            if (String(item.pkg ?? "") !== rule.notifyPkg) continue;
        }
        if (rule.notifyKeyword) {
            const text = `${item.title ?? ""} ${item.text ?? ""}`;
            if (!text.includes(rule.notifyKeyword)) continue;
        }
        matched = item;
        break;
    }
    // 无论是否命中都推进水位，避免漏检的旧通知被反复扫描
    rule.lastSeenTs = maxTs;
    return matched;
}

/** 执行规则动作：发本地通知提醒 / 打开应用 / 触发用户登记的自定义动作。参数缺省则跳过（不编造内容）。 */
function fireHuaweiRuleAction(rule: HuaweiTriggerRule, matched: Record<string, unknown> | null): { ok: boolean; detail: string } {
    const shell = getAndroidShell();
    if (!shell) return { ok: false, detail: "安卓壳未连接" };
    try {
        if (rule.action === "send_notification") {
            const title = rule.title && rule.title.trim() ? rule.title.trim() : "";
            if (!title || typeof shell.sendNotification !== "function") return { ok: false, detail: "通知标题未填写" };
            let content = rule.content && rule.content.trim() ? rule.content.trim() : "";
            // template 模式：把命中通知的标题/正文填进 {payload}/{title}/{text} 占位
            if (rule.processMode === "template") {
                const hitTitle = String(matched?.title ?? "");
                const hitText = String(matched?.text ?? "");
                content = interpolateHuaweiTemplate(rule.contentTemplate || rule.content || "", {
                    payload: `${hitTitle} ${hitText}`.trim(),
                    title: hitTitle,
                    text: hitText,
                });
            }
            if (!content) return { ok: false, detail: "通知正文未填写" };
            shell.sendNotification(title, content, rule.openApp || "");
            return { ok: true, detail: `发通知：${title}` };
        }
        if (rule.action === "open_app") {
            const pkg = rule.actionPackageName && rule.actionPackageName.trim() ? rule.actionPackageName.trim() : "";
            if (!pkg || typeof shell.openApp !== "function") return { ok: false, detail: "应用包名未填写" };
            shell.openApp(pkg);
            return { ok: true, detail: `打开应用：${pkg}` };
        }
        if (rule.action === "custom_action") {
            const name = rule.actionName && rule.actionName.trim() ? rule.actionName.trim() : "";
            if (!name) return { ok: false, detail: "未选择自定义动作" };
            const action = loadHuaweiCustomActions().find(item => item.enabled && item.name === name);
            if (!action) return { ok: false, detail: `动作「${name}」不存在或已停用` };
            const r = executeHuaweiRuleActionByName(action);
            return { ok: r.ok, detail: r.text };
        }
        return { ok: false, detail: "未知动作类型" };
    } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
}

/** 把桥返回的 JSON 外壳解析成给人看的一句话结果（与快捷动作 Tab 的 explainResult 等价）。 */
function summarizeActionResult(type: HuaweiCustomActionType, statusKey: HuaweiStatusKey | undefined, raw?: string): string {
    if (!raw) return "已执行";
    let parsed: Record<string, unknown> | null = null;
    try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return raw.slice(0, 200);
    }
    if (!parsed || typeof parsed !== "object") return String(raw).slice(0, 200);
    if (parsed.ok === false) return `失败：${String(parsed.error ?? "未知错误")}`;
    switch (type) {
        case "open_app":
            return "已下发打开应用";
        case "send_notification":
            return "通知已推送到系统栏";
        case "shell": {
            const out = String(parsed.output ?? "").trim();
            return `退出码 ${String(parsed.exitCode ?? "?")}${out ? `：${out.slice(0, 200)}` : ""}`;
        }
        case "read_status": {
            switch (statusKey) {
                case "battery":
                    return `电量 ${String(parsed.battery ?? "?")}%`;
                case "volume":
                    return `媒体音量 ${String(parsed.volume ?? "?")}`;
                case "network":
                    return parsed.network ? "网络已连接" : "网络未连接";
                case "accessibility":
                    return parsed.accessibility ? "无障碍已开启" : "无障碍未开启";
                case "floating":
                    return parsed.floating ? "悬浮球已授权" : "悬浮球未授权";
                case "locked":
                    return `门禁锁 ${String(parsed.lockedApps ?? 0)} 个 App`;
                case "location": {
                    const lat = Number(parsed.lat);
                    const lng = Number(parsed.lng);
                    return Number.isFinite(lat)
                        ? `纬度 ${lat.toFixed(5)}，经度 ${lng.toFixed(5)}`
                        : "未获取到位置";
                }
                case "current_app":
                    return parsed.currentApp ? `前台：${String(parsed.currentApp)}` : "无前台应用";
                default:
                    return String(raw).slice(0, 200);
            }
        }
    }
}

/** 按自定义动作类型执行（联动规则触发路径，与 char 工具路径共用动作语义）。 */
function executeHuaweiRuleActionByName(action: HuaweiCustomAction): { ok: boolean; text: string } {
    const shell = getAndroidShell();
    if (!shell) return { ok: false, text: "安卓壳未连接" };
    let raw: string | undefined;
    switch (action.type) {
        case "open_app": {
            const pkg = action.packageName && action.packageName.trim() ? action.packageName.trim() : "";
            if (!pkg || typeof shell.openApp !== "function") return { ok: false, text: "包名未填写" };
            raw = shell.openApp(pkg) ?? undefined;
            break;
        }
        case "send_notification": {
            const title = action.title && action.title.trim() ? action.title.trim() : "";
            const content = action.content && action.content.trim() ? action.content.trim() : "";
            if (!title || !content || typeof shell.sendNotification !== "function") return { ok: false, text: "标题或正文未填写" };
            raw = shell.sendNotification(title, content, action.openApp || "") ?? undefined;
            break;
        }
        case "read_status": {
            if (!action.statusKey || !shell.getStatus) return { ok: false, text: "状态键未填写" };
            raw = shell.getStatus() ?? undefined;
            break;
        }
        case "shell": {
            const cmd = action.command && action.command.trim() ? action.command.trim() : "";
            if (!cmd || typeof shell.runShellCommand !== "function") return { ok: false, text: "命令未填写" };
            raw = shell.runShellCommand(cmd) ?? undefined;
            break;
        }
        default:
            return { ok: false, text: "未知动作类型" };
    }
    const text = summarizeActionResult(action.type, action.statusKey, raw);
    // 动作声明了结果回传时，把摘要按送达方式送到通知栏或剪贴板
    if (action.resultMode === "text") {
        try {
            if (action.deliveryMode === "clipboard") {
                shell.writeClipboard?.(text);
            } else if (typeof shell.sendNotification === "function") {
                shell.sendNotification(`[结果] ${action.name}`, text, "");
            }
        } catch { /* 结果送达失败不影响主动作是否成功 */ }
    }
    return { ok: true, text };
}

/** 立即执行一次全部规则（含当前已关闭的）：用于设置页「测试触发」按钮，不改动规则的启用状态。 */
export function runAllHuaweiTriggerRules(): { triggered: number } {
    const rules = loadHuaweiTriggerRules();
    const saved = rules.map(rule => rule.enabled);
    const now = Date.now();
    let triggered = 0;
    let changed = false;
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (!rule.enabled) rule.enabled = true;
        const matched = rule.trigger === "time" ? null : notificationRuleShouldFire(rule);
        const shouldFire = rule.trigger === "time" ? timeRuleShouldFire(rule, now) : matched !== null;
        if (!shouldFire) continue;
        const result = fireHuaweiRuleAction(rule, matched);
        appendHuaweiBridgeEvent({ kind: "rule", title: rule.name, detail: result.detail, ok: result.ok });
        if (!result.ok) continue;
        triggered++;
        rule.lastTriggeredAt = now;
        rule.triggerCount = (rule.triggerCount || 0) + 1;
        changed = true;
    }
    for (let i = 0; i < rules.length; i++) rules[i].enabled = saved[i];
    if (changed) saveHuaweiTriggerRules(rules);
    return { triggered };
}

/* ---------- OCR 手动任务（网页触发 → 原生识别 → 网页入账） ---------- */

export type HuaweiOcrTask = {
    mode: "web" | "mlkit" | "online";
    ts: number;
    sourcePkg?: string;
};

export function registerHuaweiOcrManualTask(task: HuaweiOcrTask): void {
    kvSet(HUAWEI_OCR_TASK_KEY, JSON.stringify({ ...task, ts: Date.now() }));
}

/** 取走（并清空）挂起的 OCR 手动任务；无任务返回 null。 */
export function takeHuaweiOcrManualTask(): HuaweiOcrTask | null {
    const raw = kvGet(HUAWEI_OCR_TASK_KEY);
    if (!raw) return null;
    kvSet(HUAWEI_OCR_TASK_KEY, "");
    try {
        const parsed = JSON.parse(raw) as Partial<HuaweiOcrTask>;
        if (!parsed || (parsed.mode !== "mlkit" && parsed.mode !== "online" && parsed.mode !== "web")) return null;
        return { mode: parsed.mode, ts: Number(parsed.ts) || Date.now() };
    } catch {
        return null;
    }
}
