"use client";

// components/chat/call-appearance-settings.tsx
// 语音/视频通话外观设置面板（按 characterId 存）：
// 来电铃声、通话背景、通话头像、形象来源、图片/视频生成 API 配置。

import { useState, useRef, useCallback } from "react";
import { X, Upload, Music, Image as ImageIcon, Video, User } from "lucide-react";
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

    const sectionStyle: React.CSSProperties = {
        padding: "14px 0",
        borderBottom: "0.5px solid var(--c-card-border, rgba(128,128,128,0.2))",
    };
    const labelStyle: React.CSSProperties = {
        fontSize: 14, fontWeight: 600, marginBottom: 8, display: "block",
    };
    const subLabelStyle: React.CSSProperties = {
        fontSize: 12, opacity: 0.6, marginTop: 2,
    };
    const rowBtnStyle: React.CSSProperties = {
        minHeight: 44, padding: "10px 14px", borderRadius: 12,
        border: "0.5px solid var(--c-card-border, rgba(128,128,128,0.25))",
        background: "var(--c-card, #f5f5f5)", color: "var(--c-text, #222)",
        fontSize: 14, cursor: "pointer", textAlign: "left", width: "100%",
    };
    const inputStyle: React.CSSProperties = {
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
                width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto",
                background: "var(--c-panel, #fff)", borderRadius: "20px 20px 0 0",
                padding: "16px 20px calc(20px + env(safe-area-inset-bottom))",
                boxSizing: "border-box",
            }} onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>通话外观 · {characterName}</h2>
                    <button onClick={onClose} style={{
                        minWidth: 44, minHeight: 44, border: "none", background: "transparent",
                        fontSize: 22, cursor: "pointer", color: "var(--c-text, #222)",
                    }} aria-label="关闭"><X size={20} /></button>
                </div>

                {/* 来电铃声 */}
                <div style={sectionStyle}>
                    <label style={labelStyle}><Music size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />来电铃声</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <button style={rowBtnStyle} onClick={() => ringtoneFileRef.current?.click()}>
                            选择本地音乐文件（播放铃声）
                        </button>
                        <input
                            ref={ringtoneFileRef} type="file" accept="audio/*" style={{ display: "none" }}
                            onChange={e => {
                                const f = e.target.files?.[0];
                                if (f) handleFileToDataUri(f, uri => update({ ringtoneUrl: uri }));
                                e.target.value = "";
                            }}
                        />
                        <input
                            style={inputStyle}
                            placeholder="或粘贴铃声 URL（留空=跟随系统）"
                            value={cfg.ringtoneUrl && cfg.ringtoneUrl.startsWith("http") ? cfg.ringtoneUrl : ""}
                            onChange={e => update({ ringtoneUrl: e.target.value.trim() || null })}
                        />
                        <div style={subLabelStyle}>
                            当前：{cfg.ringtoneUrl === null ? "跟随系统/振动" : cfg.ringtoneUrl === "" ? "静音" : cfg.ringtoneUrl.startsWith("data:") ? "本地音乐文件" : "自定义 URL"}
                            {cfg.ringtoneUrl && !cfg.ringtoneUrl.startsWith("data:") && cfg.ringtoneUrl !== "" && (
                                <button style={{ ...rowBtnStyle, marginTop: 6 }} onClick={() => update({ ringtoneUrl: null })}>清除自定义铃声</button>
                            )}
                        </div>
                    </div>
                </div>

                {/* 通话背景 */}
                <div style={sectionStyle}>
                    <label style={labelStyle}><ImageIcon size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />通话背景</label>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        {GRADIENT_PRESETS.map(g => (
                            <button
                                key={g.name}
                                onClick={() => update({ backgroundUrl: "", backgroundGradient: g.value })}
                                style={{
                                    width: 64, height: 44, borderRadius: 10, cursor: "pointer",
                                    border: cfg.backgroundUrl === "" && cfg.backgroundGradient === g.value
                                        ? "2px solid var(--c-icon-active, #4f8cff)" : "0.5px solid rgba(128,128,128,0.3)",
                                    background: g.value,
                                }}
                                title={g.name}
                            />
                        ))}
                    </div>
                    <button style={rowBtnStyle} onClick={() => bgFileRef.current?.click()}>上传自定义背景图片</button>
                    <input
                        ref={bgFileRef} type="file" accept="image/*" style={{ display: "none" }}
                        onChange={e => {
                            const f = e.target.files?.[0];
                            if (f) handleFileToDataUri(f, uri => update({ backgroundUrl: uri }));
                            e.target.value = "";
                        }}
                    />
                    {cfg.backgroundUrl && (
                        <button style={{ ...rowBtnStyle, marginTop: 6 }} onClick={() => update({ backgroundUrl: "" })}>清除自定义背景（用渐变）</button>
                    )}
                </div>

                {/* 通话头像 */}
                <div style={sectionStyle}>
                    <label style={labelStyle}><User size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />通话头像</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{
                            width: 56, height: 56, borderRadius: "50%", overflow: "hidden",
                            background: "var(--c-soft, #eee)", display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                            {cfg.avatarOverride
                                ? <img src={cfg.avatarOverride} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                : <span style={{ fontSize: 20, opacity: 0.4 }}>?</span>}
                        </div>
                        <div style={{ flex: 1 }}>
                            <button style={rowBtnStyle} onClick={() => avatarFileRef.current?.click()}>上传自定义头像</button>
                            <input
                                ref={avatarFileRef} type="file" accept="image/*" style={{ display: "none" }}
                                onChange={e => {
                                    const f = e.target.files?.[0];
                                    if (f) handleFileToDataUri(f, uri => update({ avatarOverride: uri }));
                                    e.target.value = "";
                                }}
                            />
                            {cfg.avatarOverride && (
                                <button style={{ ...rowBtnStyle, marginTop: 6 }} onClick={() => update({ avatarOverride: "" })}>用角色默认头像</button>
                            )}
                        </div>
                    </div>
                </div>

                {/* 角色形象来源（预留） */}
                <div style={{ ...sectionStyle, borderBottom: "none" }}>
                    <label style={labelStyle}><Video size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />角色形象来源</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {(["static", "image_api", "video_api"] as CallAvatarSource[]).map(src => (
                            <button
                                key={src}
                                style={{
                                    ...rowBtnStyle,
                                    borderColor: cfg.avatarSource === src ? "var(--c-icon-active, #4f8cff)" : undefined,
                                    background: cfg.avatarSource === src ? "color-mix(in srgb, var(--c-icon-active, #4f8cff) 10%, transparent)" : undefined,
                                }}
                                onClick={() => update({ avatarSource: src })}
                            >
                                {src === "static" ? "静态头像（默认）" : src === "image_api" ? "图片生成 API" : "视频生成 API"}
                            </button>
                        ))}
                        {(cfg.avatarSource === "image_api" || cfg.avatarSource === "video_api") && (
                            <>
                                <input style={inputStyle} placeholder="Base URL（如 https://api.openai.com/v1）"
                                    value={cfg.avatarSource === "image_api" ? cfg.imageApiConfig.baseUrl : cfg.videoApiConfig.baseUrl}
                                    onChange={e => update(cfg.avatarSource === "image_api"
                                        ? { imageApiConfig: { ...cfg.imageApiConfig, baseUrl: e.target.value } }
                                        : { videoApiConfig: { ...cfg.videoApiConfig, baseUrl: e.target.value } })} />
                                <input style={inputStyle} placeholder="API Key" type="password"
                                    value={cfg.avatarSource === "image_api" ? cfg.imageApiConfig.apiKey : cfg.videoApiConfig.apiKey}
                                    onChange={e => update(cfg.avatarSource === "image_api"
                                        ? { imageApiConfig: { ...cfg.imageApiConfig, apiKey: e.target.value } }
                                        : { videoApiConfig: { ...cfg.videoApiConfig, apiKey: e.target.value } })} />
                                <input style={inputStyle} placeholder="模型名"
                                    value={cfg.avatarSource === "image_api" ? cfg.imageApiConfig.model : cfg.videoApiConfig.model}
                                    onChange={e => update(cfg.avatarSource === "image_api"
                                        ? { imageApiConfig: { ...cfg.imageApiConfig, model: e.target.value } }
                                        : { videoApiConfig: { ...cfg.videoApiConfig, model: e.target.value } })} />
                                <div style={subLabelStyle}>接口已预留，实际生成逻辑后续接入。</div>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
