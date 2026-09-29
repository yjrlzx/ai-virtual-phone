// lib/char-tools-automation.ts
// char 经由现实桥对「真实手机」执行的、App 内能力覆盖不到的动作。
// 目前只有一项：把日程写入真实手机日历（走现实桥 outbox，由真实手机侧快捷指令执行）。
// Lifeline 记账 / 偏好记忆 / 起床闹钟 / 守护日历等已由现有内置工具覆盖，这里不重复实现。
// 现实桥未连接时优雅降级，不向调用方抛异常。

import type { ToolResult } from "./tool-executor";
import type { InternalToolDefinition } from "./internal-capability-storage";
import { bridgeConnection, appendBridgeOutbox } from "./reality-bridge/storage";

export const WRITE_REAL_CALENDAR_TOOL = "写真实手机日历";

export const WRITE_REAL_CALENDAR_TOOL_DEFINITION: InternalToolDefinition = {
    name: WRITE_REAL_CALENDAR_TOOL,
    description: "把一条日程写到{{user}}真实手机的系统日历（经现实桥由手机快捷指令执行）。{{user}}说「我下周三有模考/帮我在手机日历加个日程」时用；和 App 内守护日历不同，这是写到真实手机系统日历。",
    parameterSchema: JSON.stringify({
        type: "object",
        properties: {
            title: { type: "string", description: "日程标题，如 人大金融模考" },
            date: { type: "string", description: "日期 YYYY-MM-DD，缺省为今天" },
            startTime: { type: "string", description: "开始时间 HH:MM，可选" },
            endTime: { type: "string", description: "结束时间 HH:MM，可选" },
        },
        required: ["title"],
    }),
    usageGuide: "用户要把一个日子/日程落到真实手机系统日历（考试、复诊、提醒）时使用；现实桥未连接时会提示先在数据管理配置云端备份。",
};

function asString(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value == null) return "";
    return String(value).trim();
}

function todayIsoDate(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function executeWriteRealCalendarTool(args: Record<string, unknown>): Promise<ToolResult> {
    const title = asString(args.title);
    if (!title) {
        return { name: WRITE_REAL_CALENDAR_TOOL, success: false, error: "缺少日程标题 title" };
    }
    const connection = bridgeConnection();
    if (!connection.ready) {
        return {
            name: WRITE_REAL_CALENDAR_TOOL,
            success: false,
            error: "现实桥未连接，无法写入真实手机日历（请在数据管理配置云端备份后再试）",
        };
    }
    const date = asString(args.date) || todayIsoDate();
    const startTime = asString(args.startTime) || undefined;
    const endTime = asString(args.endTime) || undefined;
    try {
        await appendBridgeOutbox(connection.config, {
            type: "calendar.event",
            payload: JSON.stringify({ title, date, startTime, endTime }),
            source: "tool",
        });
        return {
            name: WRITE_REAL_CALENDAR_TOOL,
            success: true,
            data: `已把日程「${title}」（${date}${startTime ? ` ${startTime}` : ""}）发到真实手机日历，由手机快捷指令落历。`,
            userNotice: "已写入真实手机日历",
        };
    } catch (err) {
        return {
            name: WRITE_REAL_CALENDAR_TOOL,
            success: false,
            error: `写入真实手机日历失败：${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
