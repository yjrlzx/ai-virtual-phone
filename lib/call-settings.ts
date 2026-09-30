// lib/call-settings.ts
// 网页侧通话设置（与华为壳原生通话设置并存）：来电铃声 URL。
// 三态语义对齐安卓壳 CallAlert/RingingAlert：
//   null = 跟随系统/不播网页铃声（壳原生响铃或仅振动）
//   ""   = 只振动，不播铃声
//   非空 = HTMLAudioElement 循环播放该 URL

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const RINGTONE_KEY = "web_call_ringtone_url_v1";
registerKvMigration(RINGTONE_KEY);

/** 读网页来电铃声 URL。null=跟随系统，空串=只振动，非空=指定 URL。 */
export function loadWebCallRingtoneUrl(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const v = kvGet(RINGTONE_KEY);
        if (v === null) return null;
        return v; // 可能是 ""（只振动）
    } catch {
        return null;
    }
}

/** 写网页来电铃声 URL。传 null 清除（跟随系统），传 "" 只振动，传 URL 指定铃声。 */
export function saveWebCallRingtoneUrl(url: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (url === null) {
            // 不写——保持 null 语义
        } else {
            kvSet(RINGTONE_KEY, url);
        }
    } catch { /* 忽略写入失败 */ }
}

/**
 * 来电铃声播放器：循环播放指定 URL，直到 stop()。
 * URL 为 null 或空串时不播放（调用方自行处理振动/壳原生响铃）。
 */
export function playIncomingRingtone(url: string | null): { stop: () => void } {
    if (typeof window === "undefined") return { stop: () => {} };
    if (!url) return { stop: () => {} };
    let audio: HTMLAudioElement | null = null;
    try {
        audio = new Audio(url);
        audio.loop = true;
        audio.volume = 0.6;
        const p = audio.play();
        if (p && typeof p.catch === "function") {
            p.catch(() => { /* 自动播放被拦（未用户手势）静默忽略，振动仍在 */ });
        }
    } catch {
        audio = null;
    }
    return {
        stop: () => {
            try {
                if (audio) {
                    audio.pause();
                    audio.currentTime = 0;
                }
            } catch { /* 忽略 */ }
        },
    };
}
