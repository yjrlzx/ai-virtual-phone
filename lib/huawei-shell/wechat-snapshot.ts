"use client";

/** 华为现实桥·微信上下文快照：对齐 iOS 现实桥「微信聊天内容自动喂给 char」的行为。
 *
 * iOS 桥行为契约（lib/reality-bridge/engine.ts）：快捷指令抓微信屏幕 → 上传 bridge-inbox →
 * 规则引擎把微信内容作为对话消息注入角色上下文。华为壳没有快捷指令，改由常驻调度器周期
 * 从壳端读「最近微信通知」+「微信前台时的屏幕节点文本」，聚合成一份快照存云端 kv，
 * buildChatPromptMessages 在组装 prompt 时把它作为 system 上下文注入。
 *
 * 与 iOS 的差异：iOS 把每条微信事件写成历史消息（role=user）；华为端只维护一份最近快照，
 * 不写聊天历史（不碰 chat-storage），快照过期或无数据时自动不注入。
 */

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { getAndroidShell, invokeShellJson, parseShellJson, loadHuaweiShellSettings } from "./storage";
import { WECHAT_PACKAGE } from "./types";

const HUAWEI_WECHAT_SNAPSHOT_KEY = "huawei_bridge_wechat_snapshot_v1";
registerKvMigration(HUAWEI_WECHAT_SNAPSHOT_KEY);

/** 快照新鲜度窗口：超过这个时长未刷新就不再注入 prompt（避免 char 把几小时前的旧消息当成正在发生的事）。 */
const STALE_AFTER_MS = 30 * 60 * 1000;
/** 最多带进 prompt 的最近微信通知条数。 */
const MAX_MESSAGES = 15;
/** 屏幕文本截断长度。 */
const MAX_SCREEN_CHARS = 1500;
/** 每次刷新拉取的通知总数（从中筛微信）。 */
const NOTIFICATION_SCAN_LIMIT = 40;

export type HuaweiWechatSnapshotMessage = {
    sender: string;
    text: string;
    ts: number;
};

export type HuaweiWechatSnapshot = {
    updatedAt: number;
    /** 刷新这一刻微信是否在前台（在前台说明用户正在微信里）。 */
    foregroundWechat: boolean;
    /** 微信前台时 dumpScreen 读到的界面文本；非前台为空。 */
    screenText: string;
    /** 最近的微信通知消息（最新在前，来自系统通知栏）。 */
    messages: HuaweiWechatSnapshotMessage[];
};

/** 通知条目壳形状（与 RealityBridgeNotificationListener.snapshot 对齐：裸 JSON 数组）。 */
type NotificationEntry = {
    pkg?: unknown;
    title?: unknown;
    text?: unknown;
    ts?: unknown;
};

/** dumpScreen 节点形状（与 dumpScreenTree 对齐：裸 JSON 数组，或 {ok:false,error}）。 */
type DumpNode = {
    text?: unknown;
    desc?: unknown;
};

function asTrimmedString(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

/**
 * 从壳端拉一次最新微信动态并写进云端 kv。
 * 由 HuaweiTriggerRulesScheduler 周期调用（间隔=设置里的联动规则检查间隔）；
 * 壳未连接 / 桥开关关闭 / 没有任何微信内容时，清空快照 key（= 不注入 prompt）。
 */
export function refreshHuaweiWechatSnapshot(): void {
    try {
        const settings = loadHuaweiShellSettings();
        if (!settings.bridgeEnabled) return;
        const shell = getAndroidShell();
        if (!shell) return;

        // 1) 最近微信通知（通知使用权开启时，新消息必达；这是微信内容的可靠通道）。
        let messages: HuaweiWechatSnapshotMessage[] = [];
        const notifResult = invokeShellJson<Array<NotificationEntry>>(s =>
            (typeof s.getNotifications === "function" ? s.getNotifications(NOTIFICATION_SCAN_LIMIT) : null));
        if (notifResult.ok && Array.isArray(notifResult.data)) {
            messages = notifResult.data
                .filter(item => String(item.pkg ?? "") === WECHAT_PACKAGE)
                .map(item => ({
                    sender: asTrimmedString(item.title),
                    text: asTrimmedString(item.text),
                    ts: Number(item.ts) || Date.now(),
                }))
                .filter(item => item.sender || item.text)
                .slice(0, MAX_MESSAGES);
        }

        // 2) 前台应用：判断用户此刻是否就在微信里。
        let foregroundWechat = false;
        const appResult = invokeShellJson<{ currentApp?: unknown }>(s =>
            (typeof s.getCurrentApp === "function" ? s.getCurrentApp() : null));
        if (appResult.ok) {
            foregroundWechat = String(appResult.data.currentApp ?? "") === WECHAT_PACKAGE;
        }

        // 3) 微信前台时 dumpScreen 读界面文字（无障碍；微信若过滤则为空，通知兜底已在 messages 里）。
        let screenText = "";
        if (foregroundWechat && typeof shell.dumpScreen === "function") {
            const dumped = parseShellJson<unknown>(shell.dumpScreen());
            if (Array.isArray(dumped)) {
                const parts: string[] = [];
                for (const node of dumped as DumpNode[]) {
                    const t = asTrimmedString(node.text) || asTrimmedString(node.desc);
                    if (!t) continue;
                    // 去重相邻重复（无障碍树常把同一文本挂在父子节点上）
                    if (parts.length > 0 && parts[parts.length - 1] === t) continue;
                    parts.push(t);
                    if (parts.join("\n").length >= MAX_SCREEN_CHARS) break;
                }
                screenText = parts.join("\n").slice(0, MAX_SCREEN_CHARS);
            }
        }

        if (messages.length === 0 && !screenText) {
            // 没有新数据：清空快照，prompt 注入层读到空串就不注入。
            kvSet(HUAWEI_WECHAT_SNAPSHOT_KEY, "");
            return;
        }

        const snapshot: HuaweiWechatSnapshot = {
            updatedAt: Date.now(),
            foregroundWechat,
            screenText,
            messages,
        };
        kvSet(HUAWEI_WECHAT_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {
        // 单次刷新失败不影响调度循环；下次 tick 再来。
    }
}

/**
 * 给 char prompt 用的微信上下文段落。无快照 / 已过期 / 服务端渲染时返回空串。
 * buildChatPromptMessages 里追加为一条 system 消息。
 */
export function buildHuaweiWechatSnapshotPrompt(): string {
    if (typeof window === "undefined") return "";
    const raw = kvGet(HUAWEI_WECHAT_SNAPSHOT_KEY);
    if (!raw) return "";
    let snapshot: HuaweiWechatSnapshot;
    try {
        snapshot = JSON.parse(raw) as HuaweiWechatSnapshot;
    } catch {
        return "";
    }
    if (!snapshot || !Number.isFinite(snapshot.updatedAt)) return "";
    if (Date.now() - snapshot.updatedAt > STALE_AFTER_MS) return "";

    const body: string[] = [];
    if (snapshot.foregroundWechat && snapshot.screenText) {
        body.push(`用户此刻正在微信里，屏幕上的微信内容：\n${snapshot.screenText}`);
    }
    if (Array.isArray(snapshot.messages) && snapshot.messages.length > 0) {
        body.push("用户最近收到的微信消息（来自手机通知，最新在前）：");
        for (const m of snapshot.messages.slice(0, MAX_MESSAGES)) {
            const time = new Date(m.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
            const senderPart = m.sender ? `${m.sender}：` : "";
            const line = `${senderPart}${m.text}`.trim();
            if (line) body.push(`- ${line}（${time}）`);
        }
    }
    if (body.length === 0) return "";

    return [
        "### 现实桥·微信实时上下文",
        "（这是用户手机上真实发生的微信动态，是你「看到」的，不是用户对你说的话。自然地记得她在聊什么即可，不要复述你看到了通知、不要主动念出来，她问你再聊。）",
        ...body,
    ].join("\n");
}
