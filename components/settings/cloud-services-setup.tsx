"use client";

// 云服务状态（自托管）：数据全部来自 /api/cloud/status。
// 微信接入可点开配置（AppID/Token/Secret/AESKey 存服务器 SQLite kv）。
// 离线推送状态读真实 SSE 在线连接数。

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
    const [showWeixinDialog, setShowWeixinDialog] = useState(false);
    const [weixinForm, setWeixinForm] = useState({ appId: "", appSecret: "", token: "", encodingAesKey: "" });
    const [weixinSaving, setWeixinSaving] = useState(false);
    const [weixinMsg, setWeixinMsg] = useState("");

    const load = async () => {
        try {
            const res = await fetch("/api/cloud/status", { cache: "no-store" });
            const data = (await res.json()) as CloudStatus & { ok?: boolean; error?: string };
            if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
            setStatus(data);
            setError("");
            onConfigChanged?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    useEffect(() => {
        let cancelled = false;
        const doLoad = async () => { if (!cancelled) await load(); };
        void doLoad();
        const timer = window.setInterval(doLoad, 15_000);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [onConfigChanged]);

    const openWeixinDialog = async () => {
        setWeixinMsg("");
        try {
            const res = await fetch("/api/weixin/config", { cache: "no-store" });
            const j = await res.json();
            if (res.ok && j.ok) {
                setWeixinForm({ appId: j.appId || "", appSecret: j.appSecret || "", token: j.token || "", encodingAesKey: j.encodingAesKey || "" });
            }
        } catch { /* 用空表单 */ }
        setShowWeixinDialog(true);
    };

    const saveWeixin = async () => {
        setWeixinSaving(true);
        setWeixinMsg("");
        try {
            const res = await fetch("/api/weixin/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(weixinForm),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
            setWeixinMsg("已保存");
            await load();
            window.setTimeout(() => setShowWeixinDialog(false), 600);
        } catch (err) {
            setWeixinMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setWeixinSaving(false);
        }
    };

    const card = (
        icon: ReactNode,
        label: string,
        tone: "on" | "wait" | "off",
        detail: string,
        onClick?: () => void,
    ) => {
        const color = tone === "on"
            ? "var(--c-success, #16a34a)"
            : tone === "wait"
                ? "var(--c-warn, #d97706)"
                : "var(--c-text-sub, #999)";
        const dot = tone === "on" ? "bg-green-500" : tone === "wait" ? "bg-amber-400" : "bg-black/15";
        return (
            <button
                type="button"
                onClick={onClick}
                disabled={!onClick}
                className="flex w-full items-center gap-3 rounded-[16px] bg-black/[0.03] px-3.5 py-3 text-left"
                style={{ minHeight: 56, cursor: onClick ? "pointer" : "default" }}
            >
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
            </button>
        );
    };

    const host = status ? status.serverUrl.replace(/^https?:\/\//, "") : "…";

    const pushTone: "on" | "wait" | "off" = !status ? "off" : status.push.onlineSessions > 0 ? "on" : status.push.subscribed ? "wait" : "off";
    const pushDetail = !status
        ? "加载中…"
        : status.push.onlineSessions > 0
            ? `已连接 · ${status.push.onlineSessions} 条长连接`
            : status.push.subscribed
                ? "已部署 · 等待手机壳连接"
                : "未连接 · 请在手机壳里打开本应用";

    const backupDetail = !status
        ? "加载中…"
        : status.backup.dbBytes == null
            ? "数据文件未初始化"
            : `SQLite · ${formatBytes(status.backup.dbBytes)}${status.backup.dbModifiedAt ? ` · ${formatTime(status.backup.dbModifiedAt)}` : ""}`;

    const weixinDetail = !status
        ? "加载中…"
        : status.weixin.enabled
            ? "已启用 · 点击修改"
            : "未启用 · 点击配置";

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
                <button type="button" onClick={() => void load()} aria-label="刷新" style={{ border: "none", background: "transparent", cursor: "pointer", padding: 6 }}>
                    <RefreshCw size={15} className="shrink-0 text-gray-400" />
                </button>
            </div>

            <div className="flex flex-col gap-2">
                {card(<CloudUpload size={17} strokeWidth={1.9} />, "数据存储", status?.backup.dbBytes != null ? "on" : "off", backupDetail)}
                {card(<MessageSquare size={17} strokeWidth={1.9} />, "微信接入", status?.weixin.enabled ? "on" : "off", weixinDetail, () => void openWeixinDialog())}
                {card(<Satellite size={17} strokeWidth={1.9} />, "离线推送", pushTone, pushDetail)}
            </div>

            {error && (
                <p className="text-[calc(11px*var(--app-text-scale,1))] leading-relaxed text-red-500">
                    状态刷新失败：{error}
                </p>
            )}

            {showWeixinDialog && (
                <div className="modal-overlay" onClick={() => setShowWeixinDialog(false)}>
                    <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ textAlign: "left" }}>
                        <div className="modal-header"><h3 className="modal-title">微信接入配置</h3></div>
                        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <span className="menu-desc">AppID</span>
                                <input className="ui-input" value={weixinForm.appId} onChange={(e) => setWeixinForm({ ...weixinForm, appId: e.target.value })} placeholder="wx..." />
                            </label>
                            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <span className="menu-desc">AppSecret</span>
                                <input className="ui-input" value={weixinForm.appSecret} onChange={(e) => setWeixinForm({ ...weixinForm, appSecret: e.target.value })} placeholder="已保存则保留，显示为掩码" />
                            </label>
                            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <span className="menu-desc">Token</span>
                                <input className="ui-input" value={weixinForm.token} onChange={(e) => setWeixinForm({ ...weixinForm, token: e.target.value })} placeholder="微信后台服务器配置 Token" />
                            </label>
                            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <span className="menu-desc">EncodingAESKey（可选）</span>
                                <input className="ui-input" value={weixinForm.encodingAesKey} onChange={(e) => setWeixinForm({ ...weixinForm, encodingAesKey: e.target.value })} placeholder="43 位消息加解密密钥" />
                            </label>
                            <p className="menu-desc">配置存到云服务器 SQLite，微信后台回调地址填 {status?.serverUrl || "本服务器地址"}/api/weixin。</p>
                            {weixinMsg && <p className="menu-desc" style={{ color: weixinMsg === "已保存" ? "green" : "red" }}>{weixinMsg}</p>}
                        </div>
                        <div className="modal-footer" style={{ display: "flex", gap: 8 }}>
                            <button type="button" className="ui-btn ui-btn-primary" onClick={() => void saveWeixin()} disabled={weixinSaving}>
                                {weixinSaving ? "保存中…" : "保存"}
                            </button>
                            <button type="button" className="ui-btn ui-btn-outline" onClick={() => setShowWeixinDialog(false)}>取消</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
