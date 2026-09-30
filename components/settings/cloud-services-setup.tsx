"use client";

// 云服务状态（自托管）：纯展示页，数据全部来自 /api/cloud/status。
// 自托管后数据落在服务器本地 SQLite，推送走站内 SSE，不再有 Supabase
// Access Token、建项目、换设备重连那一套。

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CloudUpload, MessageSquare, RefreshCw, Satellite, Server } from "lucide-react";

type CloudStatus = {
  serverUrl: string;
  selfHosted: boolean;
  push: { subscribed: boolean; onlineSessions: number };
  backup: { dbBytes: number | null; dbModifiedAt: string | null };
  weixin: { enabled: boolean };
};

/** 设置页「云服务部署」独立条目的整页形态。 */
export function CloudServicesPage() {
    return (
        <div className="page-menu">
            <div className="menu-group" style={{ padding: "18px 16px" }}>
                <CloudServicesSetup />
            </div>
        </div>
    );
}

function formatBytes(bytes: number | null): string {
    if (bytes == null) return "未初始化";
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function CloudServicesSetup({ onConfigChanged }: { onConfigChanged?: () => void }) {
    const [status, setStatus] = useState<CloudStatus | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await fetch("/api/cloud/status", { cache: "no-store" });
                const data = (await res.json()) as CloudStatus & { ok?: boolean; error?: string };
                if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
                if (cancelled) return;
                setStatus(data);
                setError("");
                onConfigChanged?.();
            } catch (err) {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : String(err));
            }
        };
        void load();
        const timer = window.setInterval(load, 15_000);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [onConfigChanged]);

    const card = (
        icon: ReactNode,
        label: string,
        tone: "on" | "wait" | "off",
        detail: string,
    ) => {
        const color = tone === "on"
            ? "var(--c-success, #16a34a)"
            : tone === "wait"
                ? "var(--c-warn, #d97706)"
                : "var(--c-text-sub, #999)";
        const dot = tone === "on" ? "bg-green-500" : tone === "wait" ? "bg-amber-400" : "bg-black/15";
        return (
            <div className="flex items-center gap-3 rounded-[16px] bg-black/[0.03] px-3.5 py-3">
                <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white shadow-sm"
                    style={{ color } as CSSProperties}
                >
                    {icon}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="menu-label">{label}</span>
                    <span className="menu-desc !mt-0 min-w-0 truncate" title={detail}>{detail}</span>
                </div>
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
            </div>
        );
    };

    const host = status ? status.serverUrl.replace(/^https?:\/\//, "") : "…";

    const pushDetail = !status
        ? "加载中…"
        : status.push.onlineSessions > 0
            ? `已连接 · ${status.push.onlineSessions} 条长连接`
            : status.push.subscribed
                ? "已部署 · 等待手机壳连接"
                : "未部署 · 请到手机壳里登录";

    const backupDetail = !status
        ? "加载中…"
        : status.backup.dbBytes == null
            ? "数据文件未初始化"
            : `SQLite · ${formatBytes(status.backup.dbBytes)}${status.backup.dbModifiedAt ? ` · ${formatTime(status.backup.dbModifiedAt)}` : ""}`;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-[16px] bg-black/[0.03] px-3.5 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white shadow-sm text-gray-700">
                    <Server size={17} strokeWidth={1.9} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="menu-label">当前服务器</span>
                    <span className="menu-desc !mt-0 min-w-0 truncate">{host}</span>
                </div>
                <RefreshCw size={13} className="shrink-0 text-gray-300" />
            </div>

            <div className="flex flex-col gap-2">
                {card(<CloudUpload size={17} strokeWidth={1.9} />, "数据存储", status?.backup.dbBytes != null ? "on" : "off", backupDetail)}
                {card(<MessageSquare size={17} strokeWidth={1.9} />, "微信接入", "off", status?.weixin.enabled ? "已启用" : "未启用 · 需自行配置")}
                {card(<Satellite size={17} strokeWidth={1.9} />, "离线推送", !status ? "off" : status.push.onlineSessions > 0 ? "on" : status.push.subscribed ? "wait" : "off", pushDetail)}
            </div>

            {error && (
                <p className="text-[calc(11px*var(--app-text-scale,1))] leading-relaxed text-red-500">
                    状态刷新失败：{error}
                </p>
            )}
        </div>
    );
}
