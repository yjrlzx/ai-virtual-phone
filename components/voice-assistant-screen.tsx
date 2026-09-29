"use client";

// components/voice-assistant-screen.tsx
// 全屏语音助手覆盖层，风格参考 Operit 悬浮全屏助手：
// 深色渐变底 + 冰蓝光晕 + 呼吸头像 + 消息流 + 波形 + 底部控制栏。
// 回合制：说话 → 文字 → AI → 朗读，不使用 WebRTC。

import { useState, useRef, useEffect, useCallback } from "react";
import { sendLLMRequest } from "@/lib/chat-engine";
import { loadApiConfigs } from "@/lib/settings-storage";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlobViaMediaElement } from "@/lib/tts-service";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { getAndroidShell, loadHuaweiShellSettings } from "@/lib/huawei-shell/storage";
import type { HuaweiShellBridge } from "@/lib/huawei-shell/types";
import { loadVoiceAssistantPersona } from "@/lib/voice-assistant-store";

// TODO(后续接入正式 session)：当前用 loadApiConfigs()[0] + localStorage 人设做最小对话兜底，
//       后续应替换为正式 ChatSession / Character 注入。

type AssistantStatus = "idle" | "listening" | "thinking" | "speaking";

type Bubble = {
    id: string;
    role: "user" | "assistant";
    text: string;
};

const WAVE_BAR_COUNT = 24;

/** 华为壳原生 STT 是否可用：window.AndroidShell.startListening 存在即视为可用。 */
function huaweiNativeSttAvailable(): boolean {
    return typeof window !== "undefined"
        && Boolean((window as unknown as { AndroidShell?: { startListening?: unknown } }).AndroidShell?.startListening);
}

const STATUS_LABEL: Record<AssistantStatus, string> = {
    idle: "点按麦克风说话",
    listening: "聆听中…",
    thinking: "思考中…",
    speaking: "她在说话…",
};

export function VoiceAssistantScreen({ onClose }: { onClose: () => void }) {
    const [status, setStatus] = useState<AssistantStatus>("idle");
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    const [interimText, setInterimText] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [shellAvailable, setShellAvailable] = useState(false);

    const statusRef = useRef<AssistantStatus>("idle");
    const mutedRef = useRef(false);
    const shellRef = useRef<HuaweiShellBridge | null>(null);
    const sttRef = useRef<STTSession | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const historyRef = useRef<LLMMessage[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => { statusRef.current = status; }, [status]);
    useEffect(() => { mutedRef.current = isMuted; }, [isMuted]);

    // 消息流自动滚到底
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [bubbles, interimText]);

    // ── AI 生成：最小 session 兜底（loadApiConfigs[0] + localStorage 人设） ──
    const generateReply = useCallback(async (userText: string): Promise<string> => {
        const configs = loadApiConfigs();
        if (configs.length === 0) {
            throw new Error("尚未配置大模型 API，请先在设置里添加");
        }
        const config = configs[0];
        const persona = loadVoiceAssistantPersona();
        const messages: LLMMessage[] = [
            { role: "system", content: persona },
            ...historyRef.current.slice(-20),
            { role: "user", content: userText },
        ];
        const reply = await sendLLMRequest(config, null, messages, [], undefined, {
            appId: "voice-assistant",
        });
        return reply.trim() || "……";
    }, []);

    // ── TTS 朗读：优先走已绑定音色，失败回落浏览器 speechSynthesis ──
    const speak = useCallback(async (text: string): Promise<void> => {
        if (!text.trim()) return;
        const voiceConfig = resolveVoiceConfig("voice-assistant");
        if (voiceConfig) {
            try {
                const blob = await synthesizeSpeech(text, voiceConfig);
                if (blob) {
                    const { promise, abort } = playAudioBlobViaMediaElement(blob);
                    audioAbortRef.current = abort;
                    await promise;
                    audioAbortRef.current = null;
                    return;
                }
            } catch (e) {
                console.warn("[VoiceAssistant] TTS failed, fallback to speechSynthesis:", e);
            }
        }
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
            await new Promise<void>((resolve) => {
                const u = new SpeechSynthesisUtterance(text);
                u.lang = "zh-CN";
                u.onend = () => resolve();
                u.onerror = () => resolve();
                window.speechSynthesis.speak(u);
            });
        }
    }, []);

    // ── 单轮对话：用户文本 → AI 回复 → 朗读 ──
    const runTurn = useCallback(async (userText: string) => {
        setBubbles(prev => [...prev, { id: `u-${Date.now()}`, role: "user", text: userText }]);
        setInterimText("");
        setStatus("thinking");

        let reply = "";
        try {
            reply = await generateReply(userText);
        } catch (e) {
            reply = `抱歉，我这边出了点问题：${e instanceof Error ? e.message : "未知错误"}`;
        }

        historyRef.current.push({ role: "user", content: userText });
        historyRef.current.push({ role: "assistant", content: reply });
        setBubbles(prev => [...prev, { id: `a-${Date.now()}`, role: "assistant", text: reply }]);

        setStatus("speaking");
        await speak(reply);

        if (statusRef.current === "speaking") setStatus("idle");
        // 华为壳免提模式：朗读结束自动重新开麦
        if (shellRef.current && !mutedRef.current) {
            startShellListening();
        }
    }, [generateReply, speak]);

    // ── 华为壳原生 STT ──
    const startShellListening = useCallback(() => {
        const shell = shellRef.current;
        if (!shell || typeof shell.startListening !== "function") return;
        try {
            const settings = loadHuaweiShellSettings();
            const mode = settings.sttMode === "cloud" ? "system" : settings.sttMode;
            shell.startListening(JSON.stringify({
                mode,
                url: settings.sttOnlineUrl,
                key: settings.sttOnlineKey,
                model: settings.sttOnlineModel,
            }));
        } catch { /* 启动失败不影响 UI */ }
    }, []);

    const stopShellListening = useCallback(() => {
        const shell = shellRef.current;
        if (shell && typeof shell.stopListening === "function") {
            try { shell.stopListening(); } catch { /* 忽略 */ }
        }
    }, []);

    // 注册华为壳识别结果回传 __floatBridgeOnSpeechText
    useEffect(() => {
        if (!shellAvailable) return;
        const w = window as unknown as { __floatBridgeOnSpeechText?: (json: string) => void };
        const handler = (json: string) => {
            let text = "";
            try {
                const parsed = JSON.parse(json) as { text?: string; ok?: boolean };
                if (parsed.ok && typeof parsed.text === "string" && parsed.text.trim()) {
                    text = parsed.text.trim();
                }
            } catch { /* 非法回传忽略 */ }
            if (!text) {
                if (statusRef.current === "listening" || statusRef.current === "thinking") {
                    setStatus("idle");
                }
                return;
            }
            void runTurn(text);
        };
        const prev = w.__floatBridgeOnSpeechText;
        const wrapped = (json: string) => {
            handler(json);
            if (typeof prev === "function") { try { prev(json); } catch { /* 忽略 */ } }
        };
        w.__floatBridgeOnSpeechText = wrapped;
        return () => {
            if (w.__floatBridgeOnSpeechText === wrapped) {
                w.__floatBridgeOnSpeechText = (typeof prev === "function" ? prev : undefined);
            }
        };
    }, [shellAvailable, runTurn]);

    // 打开时：初始化壳桥，可用则直接进入聆听态
    useEffect(() => {
        const shell = getAndroidShell();
        const nativeAvailable = Boolean(shell?.startListening) && huaweiNativeSttAvailable();
        shellRef.current = shell;
        setShellAvailable(nativeAvailable);
        if (nativeAvailable) {
            setStatus("listening");
            const t = setTimeout(() => startShellListening(), 300);
            return () => clearTimeout(t);
        }
    }, [startShellListening]);

    // 卸载兜底：停识别、停播放、停铃声、归还麦克风
    useEffect(() => {
        return () => {
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
            if (typeof window !== "undefined" && "speechSynthesis" in window) {
                window.speechSynthesis.cancel();
            }
            stopShellListening();
        };
    }, [stopShellListening]);

    // ── 非壳降级：长按说话（Web Speech API） ──
    const holdStart = useCallback(() => {
        if (shellRef.current || mutedRef.current) return;
        if (statusRef.current !== "idle") return;
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setInterimText("");
        const stt = createSTTSession({
            onInterim: (text) => {
                setInterimText(text);
                if (statusRef.current === "idle") setStatus("listening");
            },
            onFinal: (text) => {
                sttRef.current = null;
                if (text.trim()) void runTurn(text.trim());
                else setStatus("idle");
            },
            onError: () => {
                sttRef.current = null;
                setInterimText("");
                setStatus("idle");
            },
            onEnd: () => {
                sttRef.current = null;
                setInterimText("");
                setStatus("idle");
            },
            onNoSpeech: () => {
                sttRef.current = null;
                setInterimText("");
                setStatus("idle");
            },
        }, "zh-CN");
        if (!stt.isSupported) {
            setBubbles(prev => [...prev, {
                id: `e-${Date.now()}`,
                role: "assistant",
                text: "当前浏览器不支持语音识别，请在华为壳内使用",
            }]);
            return;
        }
        sttRef.current = stt;
        setStatus("listening");
        stt.start();
    }, [runTurn]);

    const holdEnd = useCallback(() => {
        if (shellRef.current) return;
        if (sttRef.current) { sttRef.current.stop(); }
    }, []);

    // 中间麦克风按钮：壳模式点按开关麦；非壳模式长按说话
    const handleMicPointerDown = useCallback(() => {
        if (shellRef.current) {
            if (statusRef.current === "idle" && !mutedRef.current) {
                setStatus("listening");
                startShellListening();
            }
        } else {
            holdStart();
        }
    }, [startShellListening, holdStart]);

    const handleMicPointerUp = useCallback(() => {
        if (shellRef.current) {
            if (statusRef.current === "listening") {
                stopShellListening();
            }
        } else {
            holdEnd();
        }
    }, [stopShellListening, holdEnd]);

    const handleToggleMute = useCallback(() => {
        setIsMuted(m => {
            const next = !m;
            if (next && sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (next) stopShellListening();
            return next;
        });
    }, [stopShellListening]);

    const handleClose = useCallback(() => {
        stopShellListening();
        onClose();
    }, [stopShellListening, onClose]);

    // 波形是否活跃
    const waveActive = status === "listening" || status === "speaking";
    const waveMode = status === "listening" ? "listen" : status === "speaking" ? "speak" : "idle";

    return (
        <div className="va-overlay">
            <style>{VA_CSS}</style>

            {/* 呼吸光晕 */}
            <div className="va-glow" />

            {/* 右上角关闭 */}
            <button type="button" className="va-close" onClick={handleClose} aria-label="关闭">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
            </button>

            <div className="va-body">
                {/* 头像 + 状态 */}
                <div className="va-avatar-block">
                    <div className="va-avatar-wrap" data-status={status}>
                        <span className="va-ripple va-ripple-1" />
                        <span className="va-ripple va-ripple-2" />
                        <div className="va-avatar">
                            <span className="va-eye va-eye-l" />
                            <span className="va-eye va-eye-r" />
                            <span className="va-smile" />
                        </div>
                    </div>
                    <div className="va-status" style={{ color: "#a8d8ff" }}>
                        {STATUS_LABEL[status]}
                    </div>
                </div>

                {/* 消息流 */}
                <div className="va-messages" ref={scrollRef}>
                    {bubbles.map(b => (
                        <div key={b.id} className={`va-bubble ${b.role === "user" ? "va-bubble-user" : "va-bubble-ai"}`}>
                            {b.text}
                        </div>
                    ))}
                    {interimText && status === "listening" && (
                        <div className="va-bubble va-bubble-user va-interim">{interimText}</div>
                    )}
                </div>

                {/* 波形可视化 */}
                <div className="va-wave" data-active={waveActive ? "" : undefined} data-mode={waveMode}>
                    {Array.from({ length: WAVE_BAR_COUNT }).map((_, i) => (
                        <span
                            key={i}
                            className="va-wave-bar"
                            style={{
                                animationDelay: `${(i % 7) * 0.09}s`,
                                animationDuration: waveMode === "listen"
                                    ? `${0.7 + (i % 5) * 0.13}s`
                                    : waveMode === "speak"
                                        ? `${0.5 + (i % 4) * 0.11}s`
                                        : `${3.2 + (i % 5) * 0.4}s`,
                            }}
                        />
                    ))}
                </div>

                {/* 底部控制栏 */}
                <div className="va-controls">
                    <button
                        type="button"
                        className="va-ctrl-btn"
                        onClick={handleToggleMute}
                        aria-label={isMuted ? "取消静音" : "静音"}
                        data-on={isMuted ? "" : undefined}
                    >
                        {isMuted ? (
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="1" y1="1" x2="23" y2="23" />
                                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.15" />
                                <line x1="12" y1="19" x2="12" y2="23" />
                            </svg>
                        ) : (
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" y1="19" x2="12" y2="22" />
                            </svg>
                        )}
                    </button>

                    <button
                        type="button"
                        className="va-mic"
                        data-state={status}
                        onPointerDown={handleMicPointerDown}
                        onPointerUp={handleMicPointerUp}
                        onPointerCancel={handleMicPointerUp}
                        aria-label="麦克风"
                    >
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="22" />
                        </svg>
                    </button>

                    <button type="button" className="va-ctrl-btn va-hangup" onClick={handleClose} aria-label="关闭">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                            <line x1="23" y1="1" x2="1" y2="23" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── 样式（深色 + 冰蓝 + 磨砂 + Y2K） ──────────────────────────────
const VA_CSS = `
.va-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    background: linear-gradient(160deg, #0b1a2e 0%, #16294a 100%);
    color: #fff;
    overflow: hidden;
    font-family: inherit;
}
.va-glow {
    position: absolute;
    left: 50%;
    top: 30%;
    width: 420px;
    height: 420px;
    transform: translate(-50%, -50%);
    background: radial-gradient(circle, rgba(126,200,255,0.35) 0%, rgba(126,200,255,0.08) 45%, transparent 70%);
    border-radius: 50%;
    pointer-events: none;
    animation: va-breathe 4.5s ease-in-out infinite;
}
@keyframes va-breathe {
    0%, 100% { opacity: 0.6; transform: translate(-50%, -50%) scale(1); }
    50% { opacity: 1; transform: translate(-50%, -50%) scale(1.12); }
}
.va-close {
    position: absolute;
    top: max(16px, env(safe-area-inset-top));
    right: 16px;
    z-index: 20;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(255,255,255,0.08);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
}
.va-body {
    position: relative;
    z-index: 10;
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 24px 18px;
    padding-bottom: max(20px, env(safe-area-inset-bottom));
}
.va-avatar-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 28px;
}
.va-avatar-wrap {
    position: relative;
    width: 140px;
    height: 140px;
    display: flex;
    align-items: center;
    justify-content: center;
}
.va-avatar {
    position: relative;
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #a8d8ff 0%, #4a90d9 55%, #1d3a66 100%);
    box-shadow: 0 0 40px rgba(126,200,255,0.45), inset 0 0 20px rgba(255,255,255,0.2);
    display: flex;
    align-items: center;
    justify-content: center;
}
.va-eye {
    position: absolute;
    top: 46px;
    width: 10px;
    height: 14px;
    background: #0b1a2e;
    border-radius: 50%;
}
.va-eye-l { left: 38px; }
.va-eye-r { right: 38px; }
.va-smile {
    position: absolute;
    bottom: 34px;
    width: 34px;
    height: 18px;
    border: 3px solid #0b1a2e;
    border-top: none;
    border-radius: 0 0 40px 40px;
}
.va-ripple {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid rgba(168,216,255,0.5);
    pointer-events: none;
    opacity: 0;
}
.va-avatar-wrap[data-status="idle"] .va-ripple {
    animation: va-ripple-idle 3.6s ease-out infinite;
}
.va-avatar-wrap[data-status="listening"] .va-ripple,
.va-avatar-wrap[data-status="thinking"] .va-ripple {
    animation: va-ripple-listen 1.6s ease-out infinite;
}
.va-avatar-wrap[data-status="speaking"] .va-ripple {
    animation: va-ripple-speak 0.9s ease-out infinite;
}
.va-ripple-2 { animation-delay: 0.8s !important; }
@keyframes va-ripple-idle {
    0% { transform: scale(1); opacity: 0.5; }
    100% { transform: scale(1.35); opacity: 0; }
}
@keyframes va-ripple-listen {
    0% { transform: scale(1); opacity: 0.7; }
    100% { transform: scale(1.55); opacity: 0; }
}
@keyframes va-ripple-speak {
    0% { transform: scale(1); opacity: 0.8; }
    100% { transform: scale(1.45); opacity: 0; }
}
.va-status {
    margin-top: 18px;
    font-size: 18px;
    font-weight: 500;
    text-shadow: 0 0 12px rgba(126,200,255,0.5);
}
.va-messages {
    flex: 1;
    min-height: 0;
    margin-top: 18px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 4px 2px;
    mask-image: linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 12px), transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 12px), transparent 100%);
}
.va-bubble {
    max-width: 82%;
    padding: 10px 14px;
    border-radius: 20px;
    font-size: 15px;
    line-height: 1.5;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
}
.va-bubble-user {
    align-self: flex-end;
    background: rgba(126,200,255,0.22);
    border: 1px solid rgba(126,200,255,0.35);
    border-bottom-right-radius: 6px;
}
.va-bubble-ai {
    align-self: flex-start;
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.14);
    border-bottom-left-radius: 6px;
}
.va-interim { opacity: 0.6; font-style: italic; }
.va-wave {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin: 14px 0;
}
.va-wave-bar {
    width: 3px;
    height: 8px;
    border-radius: 3px;
    background: #7ec8ff;
    opacity: 0.5;
    animation: va-wave-idle 3s ease-in-out infinite;
}
.va-wave[data-active] .va-wave-bar { opacity: 0.95; }
.va-wave[data-mode="listen"][data-active] .va-wave-bar { animation-name: va-wave-listen; }
.va-wave[data-mode="speak"][data-active] .va-wave-bar { animation-name: va-wave-speak; }
@keyframes va-wave-idle {
    0%, 100% { height: 6px; }
    50% { height: 14px; }
}
@keyframes va-wave-listen {
    0%, 100% { height: 6px; }
    50% { height: 34px; }
}
@keyframes va-wave-speak {
    0%, 100% { height: 10px; }
    30% { height: 38px; }
    60% { height: 18px; }
}
.va-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 36px;
    padding-top: 8px;
}
.va-ctrl-btn {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(255,255,255,0.1);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
}
.va-ctrl-btn[data-on] { color: #a8d8ff; }
.va-hangup { color: #ff9a9a; }
.va-mic {
    position: relative;
    width: 76px;
    height: 76px;
    border-radius: 50%;
    border: none;
    background: linear-gradient(145deg, #a8d8ff, #4a90d9);
    color: #0b1a2e;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 30px rgba(126,200,255,0.6);
    touch-action: none;
}
.va-mic[data-state="listening"] {
    box-shadow: 0 0 0 0 rgba(255,90,90,0.6);
    animation: va-mic-pulse 1.2s ease-out infinite;
}
@keyframes va-mic-pulse {
    0% { box-shadow: 0 0 0 0 rgba(255,90,90,0.55); }
    100% { box-shadow: 0 0 0 26px rgba(255,90,90,0); }
}
`;
