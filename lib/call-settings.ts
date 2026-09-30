// lib/call-settings.ts
// 网页侧通话设置（与华为壳原生通话设置并存）：
// - 全局来电铃声 URL（三态：null=跟随系统、""=只振动、非空=指定 URL）
// - 按 characterId 存通话外观：铃声、背景、头像、形象来源、图片/视频 API 配置

import { kvGet, kvSet, registerKvMigration, registerDynamicPrefix } from "./kv-db";

// ── 全局铃声（保留旧字段，兼容） ──
const RINGTONE_KEY = "web_call_ringtone_url_v1";
registerKvMigration(RINGTONE_KEY);

export function loadWebCallRingtoneUrl(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const v = kvGet(RINGTONE_KEY);
        if (v === null) return null;
        return v;
    } catch {
        return null;
    }
}

export function saveWebCallRingtoneUrl(url: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (url !== null) kvSet(RINGTONE_KEY, url);
    } catch { /* 忽略 */ }
}

// ── 按角色的通话外观配置 ──

export type CallAvatarSource = "static" | "image_api" | "video_api";

export type CallApiConfig = {
    baseUrl: string;
    apiKey: string;
    model: string;
};

export type CallAppearanceConfig = {
    /** 来电铃声 URL；null=跟随全局/系统，""=静音，非空=播放 */
    ringtoneUrl: string | null;
    /** 通话背景图片 URL/data URI；空=用渐变 */
    backgroundUrl: string;
    /** 预设渐变色（当 backgroundUrl 为空时用） */
    backgroundGradient: string;
    /** 自定义通话头像 data URI/URL；空=用 character.avatar */
    avatarOverride: string;
    /** 角色形象来源：静态头像 / 图片生成 API / 视频生成 API */
    avatarSource: CallAvatarSource;
    /** 图片生成 API 配置（avatarSource=image_api 时用） */
    imageApiConfig: CallApiConfig;
    /** 视频生成 API 配置（avatarSource=video_api 时用） */
    videoApiConfig: CallApiConfig;
};

const DEFAULT_APPEARANCE: CallAppearanceConfig = {
    ringtoneUrl: null,
    backgroundUrl: "",
    backgroundGradient: "linear-gradient(160deg, #1a2744 0%, #0f1629 100%)",
    avatarOverride: "",
    avatarSource: "static",
    imageApiConfig: { baseUrl: "", apiKey: "", model: "" },
    videoApiConfig: { baseUrl: "", apiKey: "", model: "" },
};

function appearanceKey(characterId: string): string {
    return `web_call_appearance_v1_${characterId}`;
}
registerDynamicPrefix("web_call_appearance_v1_");

export function loadCallAppearance(characterId: string): CallAppearanceConfig {
    if (typeof window === "undefined" || !characterId) return { ...DEFAULT_APPEARANCE };
    try {
        const raw = kvGet(appearanceKey(characterId));
        if (!raw) return { ...DEFAULT_APPEARANCE };
        const parsed = JSON.parse(raw) as Partial<CallAppearanceConfig>;
        return {
            ...DEFAULT_APPEARANCE,
            ...parsed,
            imageApiConfig: { ...DEFAULT_APPEARANCE.imageApiConfig, ...(parsed.imageApiConfig ?? {}) },
            videoApiConfig: { ...DEFAULT_APPEARANCE.videoApiConfig, ...(parsed.videoApiConfig ?? {}) },
        };
    } catch {
        return { ...DEFAULT_APPEARANCE };
    }
}

export function saveCallAppearance(characterId: string, config: CallAppearanceConfig): void {
    if (typeof window === "undefined" || !characterId) return;
    try {
        kvSet(appearanceKey(characterId), JSON.stringify(config));
    } catch { /* 忽略 */ }
}

/** 解析通话页实际用的头像：自定义覆盖 > 角色头像 > null */
export function resolveCallAvatar(characterId: string, characterAvatar: string | null | undefined): string | null {
    const cfg = loadCallAppearance(characterId);
    if (cfg.avatarOverride) return cfg.avatarOverride;
    return characterAvatar || null;
}

/** 解析通话页实际用的背景：自定义图片 > 角色头像模糊 > 渐变 */
export function resolveCallBackground(characterId: string): string {
    const cfg = loadCallAppearance(characterId);
    return cfg.backgroundUrl || cfg.backgroundGradient;
}

/** 解析来电铃声 URL：角色配置 > 全局配置 > null */
export function resolveCallRingtoneUrl(characterId: string): string | null {
    const cfg = loadCallAppearance(characterId);
    if (cfg.ringtoneUrl !== null) return cfg.ringtoneUrl;
    return loadWebCallRingtoneUrl();
}

// ── 铃声播放器 ──

export type BuiltInRingtone = { id: string; name: string };

export const BUILT_IN_RINGTONES: BuiltInRingtone[] = [
    { id: "classic", name: "经典叮咚" },
    { id: "soft", name: "轻柔提示" },
    { id: "pulse", name: "电子脉冲" },
    { id: "rising", name: "渐强铃音" },
];

function playBuiltinRingtone(id: string): { stop: () => void } {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return { stop: () => {} };
    let ctx: AudioContext | null = null;
    let stopped = false;
    let timer: number | null = null;
    try {
        ctx = new AudioContext();
        const playNote = (freq: number, start: number, dur: number, gainVal = 0.15) => {
            if (!ctx) return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.value = freq;
            osc.type = "sine";
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(gainVal, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
            osc.start(start); osc.stop(start + dur);
        };
        const playLoop = () => {
            if (stopped || !ctx) return;
            const t = ctx.currentTime;
            if (id === "classic") {
                playNote(880, t, 0.3); playNote(660, t + 0.35, 0.5);
            } else if (id === "soft") {
                playNote(720, t, 0.4, 0.1); playNote(720, t + 0.6, 0.4, 0.1);
            } else if (id === "pulse") {
                playNote(1200, t, 0.08, 0.12); playNote(1200, t + 0.15, 0.08, 0.12); playNote(1200, t + 0.3, 0.08, 0.12);
            } else if (id === "rising") {
                playNote(440, t, 0.3); playNote(587, t + 0.3, 0.3); playNote(880, t + 0.6, 0.5, 0.2);
            }
        };
        playLoop();
        timer = window.setInterval(playLoop, 2000);
    } catch {
        ctx = null;
    }
    return {
        stop: () => {
            stopped = true;
            if (timer) window.clearInterval(timer);
            if (ctx) { try { ctx.close(); } catch {} }
        },
    };
}

export function previewBuiltinRingtone(id: string): { stop: () => void } {
    return playBuiltinRingtone(id);
}

export function playIncomingRingtone(url: string | null): { stop: () => void } {
    if (typeof window === "undefined") return { stop: () => {} };
    if (!url) return { stop: () => {} };
    // 内置合成铃声
    if (url.startsWith("builtin:")) {
        return playBuiltinRingtone(url.slice(8));
    }
    let audio: HTMLAudioElement | null = null;
    try {
        audio = new Audio(url);
        audio.loop = true;
        audio.volume = 0.6;
        const p = audio.play();
        if (p && typeof p.catch === "function") {
            p.catch(() => { /* 自动播放被拦静默忽略，振动仍在 */ });
        }
    } catch {
        audio = null;
    }
    return {
        stop: () => {
            try {
                if (audio) { audio.pause(); audio.currentTime = 0; }
            } catch { /* 忽略 */ }
        },
    };
}
