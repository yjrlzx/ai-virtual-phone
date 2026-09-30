"use client";

// components/chat/call-appearance-settings.tsx
// 通话外观设置 bottom sheet（按 characterId 存）。改动即时写入 kv，底部「完成」按钮关闭。

import { useState, useRef, useCallback } from "react";
import { X, Music, Image as ImageIcon, Video, User } from "lucide-react";
import {
    loadCallAppearance,
    saveCallAppearance,
    type CallAppearanceConfig,
    type CallAvatarSource,
} from "@/lib/call-settings";

type Props = {
    characterId: string;
    characterName: string;
    onClose: () => void;
};

const GRADIENT_PRESETS = [
    { name: "深夜蓝", value: "linear-gradient(160deg, #1a2744 0%, #0f1629 100%)" },
    { name: "紫雾", value: "linear-gradient(160deg, #2d1b4e 0%, #1a1030 100%)" },
    { name: "暖橘", value: "linear-gradient(160deg, #3d2018 0%, #1f1010 100%)" },
    { name: "墨绿", value: "linear-gradient(160deg, #14291f 0%, #0a1a13 100%)" },
];

export function CallAppearanceSettings({ characterId, characterName, onClose }: Props) {
    const [cfg, setCfg] = useState<CallAppearanceConfig>(() => loadCallAppearance(characterId));
    const ringtoneFileRef = useRef<HTMLInputElement | null>(null);
    const bgFileRef = useRef<HTMLInputElement | null>(null);
    const avatarFileRef = useRef<HTMLInputElement | null>(null);

    const update = useCallback((patch: Partial<CallAppearanceConfig>) => {
        setCfg(prev => {
            const next = { ...prev, ...patch };
            saveCallAppearance(characterId, next);
            return next;
        });
    }, [characterId]);

    const handleFileToDataUri = (file: File, onData: (dataUri: string) => void) => {
        const reader = new FileReader();
        reader.onload = () => onData(String(reader.result));
        reader.readAsDataURL(file);
    };

    const sectionTitle: React.CSSProperties = {
        fontSize: 13, fontWeight: 700, opacity: 0.6, textTransform: "uppercase",
        letterSpacing: 1, marginBottom: 10,
    };
    const rowBtn: React.CSSProperties = {
        minHeight: 44, padding: "10px 14px", borderRadius: 12,
        border: "0.5px solid var(--c-card-border, rgba(128,128,128,0.25))",
        background: "var(--c-card, #f5f5f5)", color: "var(--c-text, #222)",
        fontSize: 14, cursor: "pointer", textAlign: "left", width: "100%",
    };
    const input: React.CSSProperties = {
        width: "100%", minHeight: 44, padding: "10px 12px", borderRadius: 10,
        border: "0.5px solid var(--c-card-border, rgba(128,128,128,0.25))",
        background: "var(--c-input-bg, #fff)", color: "var(--c-text, #222)",
        fontSize: 16, boxSizing: "border-box",
    };

    return (
        <div style={{
            position: "fixed", inset: 0, zIndex: 100000,
            display: "flex", alignItems: "flex-end", justifyContent: "center",
            background: "rgba(0,0,0,0.5)",
        }} onClick={onClose}>
            <div style={{
                width: "100%", maxWidth: 480, maxHeight: "85vh", display: "flex", flexDirection: "column",
                background: "var(--c-panel, #fff)", borderRadius: "20px 20px 0 0",
            }} onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "14px 20px 10px", flexShrink: 0,
                }}>
                    <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>通话外观 · {characterName}</h2>
                    <button onClick={onClose} style={{
                        minWidth: 44, minHeight: 44, border: "none", background: "transparent",
                        cursor: "pointer", color: "var(--c-text, #222)", display: "flex", alignItems: "center",
                    }} aria-label="关闭"><X size={20} /></button>
                </div>

                {/* Scrollable body */}
                <div style={{ flex: 1, overflowY: "auto", padding: "0 20px" }}>
                    {/* 铃声 */}
                    <div style={{ padding: "10px 0 16px", borderBottom: "0.5px solid var(--c-card-border, rgba(128,128,128,0.15))" }}>
                        <div style={sectionTitle}><Music size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />来电铃声</div>
                        <button style={rowBtn} onClick={() => ringtoneFileRef.current?.click()}>选本地音乐文件</button>
                        <input ref={ringtoneFileRef} type="file" accept="audio/*" style={{ display: "none" }}
                            onChange={e => { const f = e.target.files?.[0]; if (f) handleFileToDataUri(f, uri => update({ ringtoneUrl: uri })); e.target.value = ""; }} />
                        <input style={{ ...input, marginTop: 8 }} placeholder="或粘贴铃声 URL（留空=跟随系统）"
                            value={cfg.ringtoneUrl && cfg.ringtoneUrl.startsWith("http") ? cfg.ringtoneUrl : ""}
                            onChange={e => update({ ringtoneUrl: e.target.value.trim() || null })} />
                        <div style={{ fontSize: 11, opacity: 0.55, marginTop: 6 }}>
                            当前：{cfg.ringtoneUrl === null ? "跟随系统/振动" : cfg.ringtoneUrl === "" ? "静音" : cfg.ringtoneUrl.startsWith("data:") ? "本地音乐" : "自定义 URL"}
                        </div>
                    </div>

                    {/* 背景 */}
                    <div style={{ padding: "14px 0", borderBottom: "0.5px solid var(--c-card-border, rgba(128,128,128,0.15))" }}>
                        <div style={sectionTitle}><ImageIcon size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />通话背景</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                            {GRADIENT_PRESETS.map(g => (
                                <button key={g.name} title={g.name}
                                    onClick={() => update({ backgroundUrl: "", backgroundGradient: g.value })}
                                    style={{
                                        width: 56, height: 38, borderRadius: 8, cursor: "pointer",
                                        border: cfg.backgroundUrl === "" && cfg.backgroundGradient === g.value
                                            ? "2px solid var(--c-icon-active, #4f8cff)" : "0.5px solid rgba(128,128,128,0.3)",
                                        background: g.value,
                                    }} />
                            ))}
                        </div>
                        <button style={rowBtn} onClick={() => bgFileRef.current?.click()}>上传自定义背景图</button>
                        <input ref={bgFileRef} type="file" accept="image/*" style={{ display: "none" }}
                            onChange={e => { const f = e.target.files?.[0]; if (f) handleFileToDataUri(f, uri => update({ backgroundUrl: uri })); e.target.value = ""; }} />
                        {cfg.backgroundUrl && <button style={{ ...rowBtn, marginTop: 6 }} onClick={() => update({ backgroundUrl: "" })}>清除自定义背景</button>}
                    </div>

                    {/* 头像 */}
                    <div style={{ padding: "14px 0", borderBottom: "0.5px solid var(--c-card-border, rgba(128,128,128,0.15))" }}>
                        <div style={sectionTitle}><User size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />通话头像</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <div style={{
                                width: 52, height: 52, borderRadius: "50%", overflow: "hidden", flexShrink: 0,
                                background: "var(--c-soft, #eee)", display: "flex", alignItems: "center", justifyContent: "center",
                            }}>
                                {cfg.avatarOverride
                                    ? <img src={cfg.avatarOverride} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                    : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4 }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
                            </div>
                            <div style={{ flex: 1 }}>
                                <button style={rowBtn} onClick={() => avatarFileRef.current?.click()}>上传自定义头像</button>
                                <input ref={avatarFileRef} type="file" accept="image/*" style={{ display: "none" }}
                                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFileToDataUri(f, uri => update({ avatarOverride: uri })); e.target.value = ""; }} />
                            </div>
                        </div>
                        {cfg.avatarOverride && <button style={{ ...rowBtn, marginTop: 6 }} onClick={() => update({ avatarOverride: "" })}>用角色默认头像</button>}
                    </div>

                    {/* 形象来源 */}
                    <div style={{ padding: "14px 0 20px" }}>
                        <div style={sectionTitle}><Video size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />角色形象来源（预留）</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {(["static", "image_api", "video_api"] as CallAvatarSource[]).map(src => (
                                <button key={src}
                                    style={{
                                        ...rowBtn,
                                        borderColor: cfg.avatarSource === src ? "var(--c-icon-active, #4f8cff)" : undefined,
                                        fontWeight: cfg.avatarSource === src ? 600 : 400,
                                    }}
                                    onClick={() => update({ avatarSource: src })}>
                                    {src === "static" ? "静态头像（默认）" : src === "image_api" ? "图片生成 API" : "视频生成 API"}
                                </button>
                            ))}
                            {cfg.avatarSource !== "static" && (
                                <>
                                    <input style={input} placeholder="Base URL"
                                        value={cfg.avatarSource === "image_api" ? cfg.imageApiConfig.baseUrl : cfg.videoApiConfig.baseUrl}
                                        onChange={e => update(cfg.avatarSource === "image_api"
                                            ? { imageApiConfig: { ...cfg.imageApiConfig, baseUrl: e.target.value } }
                                            : { videoApiConfig: { ...cfg.videoApiConfig, baseUrl: e.target.value } })} />
                                    <input style={input} placeholder="API Key" type="password"
                                        value={cfg.avatarSource === "image_api" ? cfg.imageApiConfig.apiKey : cfg.videoApiConfig.apiKey}
                                        onChange={e => update(cfg.avatarSource === "image_api"
                                            ? { imageApiConfig: { ...cfg.imageApiConfig, apiKey: e.target.value } }
                                            : { videoApiConfig: { ...cfg.videoApiConfig, apiKey: e.target.value } })} />
                                    <input style={input} placeholder="模型名"
                                        value={cfg.avatarSource === "image_api" ? cfg.imageApiConfig.model : cfg.videoApiConfig.model}
                                        onChange={e => update(cfg.avatarSource === "image_api"
                                            ? { imageApiConfig: { ...cfg.imageApiConfig, model: e.target.value } }
                                            : { videoApiConfig: { ...cfg.videoApiConfig, model: e.target.value } })} />
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* Sticky footer save button */}
                <div style={{
                    padding: "12px 20px calc(12px + env(safe-area-inset-bottom))", flexShrink: 0,
                    borderTop: "0.5px solid var(--c-card-border, rgba(128,128,128,0.15))",
                }}>
                    <button onClick={onClose} style={{
                        width: "100%", minHeight: 48, borderRadius: 24, border: "none", cursor: "pointer",
                        background: "var(--c-icon-active, #4f8cff)", color: "#fff", fontSize: 16, fontWeight: 600,
                    }}>完成</button>
                </div>
            </div>
        </div>
    );
}
