// lib/voice-assistant-store.ts — 语音助手本地存储（localStorage）
//
// 独立全屏语音助手的最小持久层：只存一条预设角色人设（system prompt）。
// 对话轮次由组件内存维护，不污染正式聊天会话。
// TODO(后续接入正式 session)：把 persona 与对话历史迁到真实 ChatSession/Character，
//       这里目前只做 localStorage 兜底。

const PERSONA_KEY = "voice_assistant_persona_v1";

export const DEFAULT_VOICE_ASSISTANT_PERSONA =
    "你是一个温柔干练的语音助手，像身边可靠的朋友。" +
    "用中文简短自然地回答，每次回复控制在两三句话以内，语气轻松，不要使用列表、" +
    "markdown 或特殊符号，适合直接朗读出来。";

/** 读取语音助手人设（system prompt）。未配置时返回默认人设。 */
export function loadVoiceAssistantPersona(): string {
    if (typeof window === "undefined") return DEFAULT_VOICE_ASSISTANT_PERSONA;
    try {
        const raw = window.localStorage.getItem(PERSONA_KEY);
        if (raw && raw.trim()) return raw;
    } catch { /* 忽略读取失败 */ }
    return DEFAULT_VOICE_ASSISTANT_PERSONA;
}

/** 保存语音助手人设（设置页可改；本组件暂只读取）。 */
export function saveVoiceAssistantPersona(persona: string): void {
    if (typeof window === "undefined") return;
    try {
        if (persona && persona.trim()) {
            window.localStorage.setItem(PERSONA_KEY, persona);
        } else {
            window.localStorage.removeItem(PERSONA_KEY);
        }
    } catch { /* 忽略写入失败 */ }
}
