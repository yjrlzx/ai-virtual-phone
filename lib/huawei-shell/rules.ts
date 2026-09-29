"use client";

/** 华为壳自动联动规则引擎：检查通知/定时触发条件并执行动作。
 *  由 HuaweiTriggerRulesScheduler（全局常驻组件）周期调用；
 *  规则、触发条件、动作与检查间隔全部在 设置 → 华为壳 界面可配，代码不写死。 */

import { getAndroidShell, invokeShellJson, loadHuaweiCustomActions, loadHuaweiTriggerRules, saveHuaweiTriggerRules } from "./storage";
import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { ALIPAY_PACKAGE, WECHAT_PACKAGE } from "./types";
import type { HuaweiCustomAction, HuaweiTriggerRule } from "./types";

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
    const rules = loadHuaweiTriggerRules();
    const enabled = rules.filter(rule => rule.enabled);
    if (enabled.length === 0) return { triggered: 0 };
    if (!getAndroidShell()) return { triggered: 0 };
    const now = Date.now();
    let triggered = 0;
    let changed = false;
    for (const rule of enabled) {
        const shouldFire = rule.trigger === "time"
            ? timeRuleShouldFire(rule, now)
            : notificationRuleShouldFire(rule);
        if (!shouldFire) continue;
        if (!fireHuaweiRuleAction(rule)) continue;
        triggered++;
        rule.lastTriggeredAt = now;
        rule.triggerCount = (rule.triggerCount || 0) + 1;
        changed = true;
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

/** 通知规则：只看比 lastSeenTs 更新的通知，命中（来源 + 关键词）即触发一次。 */
function notificationRuleShouldFire(rule: HuaweiTriggerRule): boolean {
    const result = invokeShellJson<Array<Record<string, unknown>>>(shell => (shell.getNotifications ? shell.getNotifications(30) : null));
    if (!result.ok) return false;
    const list = Array.isArray(result.data) ? result.data : [];
    if (list.length === 0) return false;
    const lastSeen = rule.lastSeenTs || 0;
    let maxTs = lastSeen;
    for (const item of list) {
        const ts = Number(item.ts);
        if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
    }
    if (maxTs <= lastSeen) return false;
    const isPayment = rule.notifyPkg === "payment";
    const matched = list.some(item => {
        if (Number(item.ts) <= lastSeen) return false;
        if (isPayment) {
            const pkg = String(item.pkg ?? "");
            if (pkg !== WECHAT_PACKAGE && pkg !== ALIPAY_PACKAGE) return false;
        } else if (rule.notifyPkg) {
            if (String(item.pkg ?? "") !== rule.notifyPkg) return false;
        }
        if (rule.notifyKeyword) {
            const text = `${item.title ?? ""} ${item.text ?? ""}`;
            if (!text.includes(rule.notifyKeyword)) return false;
        }
        return true;
    });
    // 无论是否命中都推进水位，避免漏检的旧通知被反复扫描
    rule.lastSeenTs = maxTs;
    return matched;
}

/** 执行规则动作：发本地通知提醒 / 打开应用 / 触发用户登记的自定义动作。参数缺省则跳过（不编造内容）。 */
function fireHuaweiRuleAction(rule: HuaweiTriggerRule): boolean {
    const shell = getAndroidShell();
    if (!shell) return false;
    try {
        if (rule.action === "send_notification") {
            const title = rule.title && rule.title.trim() ? rule.title.trim() : "";
            const content = rule.content && rule.content.trim() ? rule.content.trim() : "";
            if (!title || !content || typeof shell.sendNotification !== "function") return false;
            shell.sendNotification(title, content, rule.openApp || "");
            return true;
        }
        if (rule.action === "open_app") {
            const pkg = rule.actionPackageName && rule.actionPackageName.trim() ? rule.actionPackageName.trim() : "";
            if (!pkg || typeof shell.openApp !== "function") return false;
            shell.openApp(pkg);
            return true;
        }
        if (rule.action === "custom_action") {
            const name = rule.actionName && rule.actionName.trim() ? rule.actionName.trim() : "";
            if (!name) return false;
            const action = loadHuaweiCustomActions().find(item => item.enabled && item.name === name);
            if (!action) return false;
            return executeHuaweiRuleActionByName(action);
        }
        return false;
    } catch {
        return false;
    }
}

/** 按自定义动作类型执行（联动规则触发路径，与 char 工具路径共用动作语义）。 */
function executeHuaweiRuleActionByName(action: HuaweiCustomAction): boolean {
    const shell = getAndroidShell();
    if (!shell) return false;
    switch (action.type) {
        case "open_app": {
            const pkg = action.packageName && action.packageName.trim() ? action.packageName.trim() : "";
            if (!pkg || typeof shell.openApp !== "function") return false;
            shell.openApp(pkg);
            return true;
        }
        case "send_notification": {
            const title = action.title && action.title.trim() ? action.title.trim() : "";
            const content = action.content && action.content.trim() ? action.content.trim() : "";
            if (!title || !content || typeof shell.sendNotification !== "function") return false;
            shell.sendNotification(title, content, action.openApp || "");
            return true;
        }
        case "read_status": {
            const key = action.statusKey;
            if (!key || !shell.getStatus) return false;
            shell.getStatus();
            return true;
        }
        case "shell": {
            const cmd = action.command && action.command.trim() ? action.command.trim() : "";
            if (!cmd || typeof shell.runShellCommand !== "function") return false;
            shell.runShellCommand(cmd);
            return true;
        }
        default:
            return false;
    }
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
        const shouldFire = rule.trigger === "time"
            ? timeRuleShouldFire(rule, now)
            : notificationRuleShouldFire(rule);
        if (!shouldFire) continue;
        if (!fireHuaweiRuleAction(rule)) continue;
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
