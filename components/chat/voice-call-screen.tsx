"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, getLatestCharacterStateValues } from "@/lib/chat-storage";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import type { StateValue } from "@/lib/chat-storage";
import { parseStateValues, mergeStateValues } from "@/lib/state-value-parser";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { generateChatCompletion, flattenCompletionResult, ChatEngineError } from "@/lib/chat-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlob, playAudioBlobViaMediaElement, setCallAudioSessionActive } from "@/lib/tts-service";
import { isCallRecordingSupported, resolveCloudSttConfig } from "@/lib/stt-cloud";
import { useHoldToTalk } from "./use-hold-to-talk";
import { suspendKeepAliveForCall, resumeKeepAliveAfterCall } from "@/lib/use-weixin-bridge";
import { BilingualTextBlock } from "./message-bubble";
import { splitBilingualText } from "@/lib/bilingual-text";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { CallSttWarningDialog, hideCallSttWarningPermanently, isCallSttWarningHidden } from "./call-stt-warning-dialog";
import { isAndroidBrowser, isIOSDevice } from "./voice-input-platform";
import { CallVolumeControl } from "./call-volume-control";
import { CallAppearanceSettings } from "./call-appearance-settings";
import { startIncomingCallVibration } from "@/lib/call-vibration";
import { getAndroidShell, loadHuaweiShellSettings } from "@/lib/huawei-shell/storage";
import { loadWebCallRingtoneUrl, playIncomingRingtone, resolveCallAvatar, resolveCallRingtoneUrl, loadCallAppearance } from "@/lib/call-settings";

/** 华为壳原生语音识别（免云端）是否可用：window.AndroidShell.startListening 存在即视为可用。 */
const huaweiNativeSttAvailable = typeof window !== "undefined"
    && Boolean((window as unknown as { AndroidShell?: { startListening?: unknown } }).AndroidShell?.startListening);

// ── Types ───────────────────────────────────────────

type CallState =
    | "CONNECTING"
    | "IDLE"
    | "USER_SPEAKING"
    | "PROCESSING"
    | "AI_SPEAKING"
    | "ENDED";

type SubtitleEntry = {
    id: string;
    role: "user" | "assistant";
    text: string;
};

type VoiceCallScreenProps = {
    session: ChatSession;
    character: Character;
    onEnd: () => void;
    onConnect?: () => void;
    initiator?: "user" | "character";
    /** 通话是否处于缩小的悬浮窗状态：暂停麦克风监听/计时/语音播放，仅显示背景+名字 */
    minimized?: boolean;
    /** 点击左上角返回键：请求缩小为悬浮窗（通话逻辑冻结，不挂断） */
    onMinimize?: () => void;
    /** 点击悬浮窗：请求恢复为全屏通话界面 */
    onRestore?: () => void;
};

function stripBilingualForSpeech(text: string): string {
    return text
        .split("\n")
        .map(line => splitBilingualText(line)?.original || line)
        .join("\n");
}

// ── Component ───────────────────────────────────────

export function VoiceCallScreen({ session, character, onEnd, onConnect, initiator = "user", minimized = false, onMinimize, onRestore }: VoiceCallScreenProps) {
    // iOS 保留 Web Speech 免提 + Web Audio 播放（麦克风会话共存的老方案）；
    // 其余设备改「按住说话 + 云端转写」，播放走媒体元素（音量键可控、无静音拨键坑）。
    // 没配 OpenAI 兼容识别时回落旧行为（安卓=文字输入）。
    const iosDeviceRef = useRef(isIOSDevice());
    const iosDevice = iosDeviceRef.current;
    const holdToTalkRef = useRef(
        !iosDeviceRef.current && isCallRecordingSupported() && resolveCloudSttConfig(session.contactId) !== null,
    );
    const holdToTalk = holdToTalkRef.current;
    // Web Speech API（webkitSpeechRecognition）在 Android Chrome 也可用；
    // 有它就允许免提直说，不必退化成纯文字。
    const webSpeechSupportedRef = useRef(
        typeof window !== "undefined"
        && Boolean((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition
            || (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition),
    );
    const webSpeechSupported = webSpeechSupportedRef.current;
    const androidTextInputOnlyRef = useRef(
        isAndroidBrowser() && !holdToTalkRef.current && !webSpeechSupportedRef.current,
    );
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    const playCallAudio = iosDevice ? playAudioBlob : playAudioBlobViaMediaElement;
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const [callState, setCallState] = useState<CallState>("CONNECTING");
    const hasConnectedRef = useRef(false);
    const [callDuration, setCallDuration] = useState(0);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [interimText, setInterimText] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [inputMode, setInputMode] = useState<"voice" | "text">(() => (androidTextInputOnly && !huaweiNativeSttAvailable) ? "text" : "voice");
    const [typedText, setTypedText] = useState("");
    const [bgImageResolved, setBgImageResolved] = useState<string | null>(null);
    const [showSttWarning, setShowSttWarning] = useState(false);
    const [showCallSettings, setShowCallSettings] = useState(false);

    // 通话头像：挂载时从存储重读最新 character.avatar（聊天里换了头像这里立刻生效）
    const [liveAvatar, setLiveAvatar] = useState<string | null | undefined>(character.avatar);
    useEffect(() => {
        try {
            const chars = loadCharacters();
            const fresh = chars.find(c => c.id === session.contactId);
            if (fresh?.avatar) setLiveAvatar(fresh.avatar);
        } catch { /* ignore */ }
    }, [session.contactId]);
    const callAvatar = resolveCallAvatar(session.contactId, liveAvatar);

    const sttRef = useRef<STTSession | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const callStartRef = useRef<number>(0);
    const pausedAtRef = useRef<number | null>(null);
    const minimizedRef = useRef(false);
    const stateRef = useRef<string>("CONNECTING");
    const mutedRef = useRef(false);
    // barge-in 标记：识别到人声打断 AI 朗读时置 true，TTS 收尾逻辑据此不再把状态抢回 IDLE
    const bargeInRef = useRef(false);
    // TTS 结束时间戳：此后 400ms 内的麦克风 interim / 原生回传文本视为扬声器回声，忽略
    const ttsEndedAtRef = useRef(0);
    const interimTextRef = useRef<string>("");  // ref 版本，闭包安全
    const sttWarningShownRef = useRef(false);
    const subtitleScrollRef = useRef<HTMLDivElement>(null);
    const messagesRef = useRef<ChatMessage[]>([]);
    // 已落库字幕 ID 集合：通话中每完成一轮 user/assistant pushChatMessage 就记一笔；
    // 挂断/卸载时据此把只在字幕状态机里、还没进 store 的真实轮次补齐。
    const persistedSubIdsRef = useRef<Set<string>>(new Set());
    const subtitlesRef = useRef<SubtitleEntry[]>([]);
    const _initUi = resolveUserIdentity(session.contactId, "chat");
    const userNameRef = useRef<string>(_initUi?.name || "你");

    // Keep refs in sync
    useEffect(() => { stateRef.current = callState; }, [callState]);
    useEffect(() => { minimizedRef.current = minimized; }, [minimized]);
    useEffect(() => { mutedRef.current = isMuted; }, [isMuted]);
    useEffect(() => { subtitlesRef.current = subtitles; }, [subtitles]);

    // 把只在字幕状态机里、还没进 store 的真实轮次补落库。
    // 已通过 pushChatMessage 落库的字幕 ID 在 persistedSubIdsRef 里，跳过；
    // 错误提示（⚠️ 开头）不是真实对话，不补。
    const flushUnpersistedSubtitles = useCallback(() => {
        for (const sub of subtitlesRef.current) {
            if (persistedSubIdsRef.current.has(sub.id)) continue;
            const text = sub.text.trim();
            if (!text || text.startsWith("⚠️")) continue;
            try {
                const msg = pushChatMessage({
                    sessionId: session.id,
                    role: sub.role === "user" ? "user" : "assistant",
                    content: text,
                });
                messagesRef.current = [...messagesRef.current, msg];
                persistedSubIdsRef.current.add(sub.id);
            } catch { /* 补落库失败不阻塞挂断 */ }
        }
    }, [session.id]);
    const flushRef = useRef(flushUnpersistedSubtitles);
    useEffect(() => { flushRef.current = flushUnpersistedSubtitles; }, [flushUnpersistedSubtitles]);

    // 缩小为悬浮窗：冻结通话——停止监听、打断在播放的语音
    useEffect(() => {
        if (!minimized) return;
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setInterimText("");
        if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
        if (window.speechSynthesis) window.speechSynthesis.cancel();
    }, [minimized]);

    // 来电等待接听：循环振动 + 网页铃声 + 华为壳原生铃声（微信式提醒）
    useEffect(() => {
        if (initiator !== "character" || callState !== "CONNECTING") return;
        const stopVib = startIncomingCallVibration();
        let shell: { stopRing?: () => void } | null = null;
        // 网页侧铃声：URL 非空时 HTMLAudioElement 循环播放；空串/null 不播（壳原生或仅振动）
        const webRingtone = playIncomingRingtone(resolveCallRingtoneUrl(session.contactId));
        try {
            if (huaweiNativeSttAvailable) {
                const s = getAndroidShell();
                if (s && typeof s.ring === "function") {
                    const settings = loadHuaweiShellSettings();
                    shell = s;
                    if (settings.callRingEnabled) s.ring(settings.callRingTimeoutSec);
                }
            }
        } catch { /* 响铃失败不影响接通流程 */ }
        return () => {
            stopVib();
            webRingtone.stop();
            try { if (shell && typeof shell.stopRing === "function") shell.stopRing(); } catch { /* 忽略 */ }
        };
    }, [initiator, callState]);

    // Pause WeChat keep-alive while the call holds the mic/audio; restore on exit.
    useEffect(() => {
        suspendKeepAliveForCall();
        return () => { resumeKeepAliveAfterCall(); };
    }, []);

    // 通话音频会话 + 卸载兜底：不经挂断键退出（返回聊天页/切会话/组件被销毁）时，
    // 把识别、在途播放与音频会话全部释放。此前识别的自动重启循环在卸载后条件
    // 恒成立（stateRef 停在 IDLE），会在后台无限自我重启，麦克风永不归还，
    // 整页音频被钉在通话模式（语音条/试听音量巨大且音量键失灵）。
    useEffect(() => {
        setCallAudioSessionActive(true);
        (window as unknown as { __huaweiCallActive?: boolean }).__huaweiCallActive = true;
        return () => {
            stateRef.current = "ENDED";
            delete (window as unknown as { __huaweiCallActive?: boolean }).__huaweiCallActive;
            // 组件被卸载（切会话/返回聊天页而非挂断键）时，补齐没落库的对话轮次
            try { flushRef.current(); } catch { /* 忽略 */ }
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
            try { const sh = getAndroidShell(); if (sh && typeof sh.stopListening === "function") sh.stopListening(); } catch { /* 忽略 */ }
            setCallAudioSessionActive(false);
        };
    }, []);
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);

    const showSttCompatibilityWarning = useCallback(() => {
        if (androidTextInputOnly && !huaweiNativeSttAvailable) {
            setInputMode("text");
            return;
        }
        if (sttWarningShownRef.current || isCallSttWarningHidden()) return;
        sttWarningShownRef.current = true;
        setShowSttWarning(true);
    }, [androidTextInputOnly]);

    const handleNeverShowSttWarning = useCallback(() => {
        hideCallSttWarningPermanently();
        setShowSttWarning(false);
    }, []);

    // Scroll subtitles to bottom on change
    useEffect(() => {
        if (subtitleScrollRef.current) {
            subtitleScrollRef.current.scrollTop = subtitleScrollRef.current.scrollHeight;
        }
    }, [subtitles, interimText]);

    // ── Resolve voiceBackground from IndexedDB ──────

    useEffect(() => {
        if (!session.voiceBackground) {
            setBgImageResolved(null);
            return;
        }
        if (session.voiceBackground.startsWith("data:") || session.voiceBackground.startsWith("http")) {
            setBgImageResolved(session.voiceBackground);
            return;
        }
        // IndexedDB ID
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.voiceBackground!).then(dataUrl => {
                if (dataUrl) setBgImageResolved(dataUrl);
            });
        });
    }, [session.voiceBackground]);

    // ── Call timer ───────────────────────────────────

    useEffect(() => {
        if (callState === "CONNECTING" || callState === "ENDED") return;

        if (!callStartRef.current) {
            callStartRef.current = Date.now();
        }

        // 缩小为悬浮窗：冻结计时显示，不再推进
        if (minimized) {
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            if (pausedAtRef.current === null) pausedAtRef.current = Date.now();
            return;
        }
        // 从悬浮窗恢复：把冻结期间流逝的时间补回起点，避免时长跳变
        if (pausedAtRef.current !== null) {
            callStartRef.current += Date.now() - pausedAtRef.current;
            pausedAtRef.current = null;
        }

        timerRef.current = setInterval(() => {
            setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
        }, 1000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [callState, minimized]);

    // ── Connecting animation (3s fake dial) ─────────

    useEffect(() => {
        cancelFollowUp(session.id);

        // Resolve user name
        const ui = resolveUserIdentity(session.contactId, "chat");
        userNameRef.current = ui?.name || "你";

        // Load existing messages for context
        messagesRef.current = loadChatMessages(session.id);

        // Insert system message (skip if already exists from strict mode remount)
        const lastMsg = messagesRef.current[messagesRef.current.length - 1];
        const initRole = initiator === "character" ? "assistant" : "user";
        if (!lastMsg || !(lastMsg.content.includes("发起了语音通话"))) {
            const callMsg = initiator === "character"
                ? `[我向${userNameRef.current}发起了语音通话]`
                : `[我向${character.name}发起了语音通话]`;
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: initRole,
                content: callMsg,
            });
            messagesRef.current = [...messagesRef.current, sysMsg];
        }

        // User-initiated: auto-connect after 3s fake dial
        // Character-initiated: wait for user to accept
        let connectTimer: NodeJS.Timeout | undefined;
        if (initiator !== "character") {
            connectTimer = setTimeout(() => {
                setCallState("IDLE");
            }, 3000);
        }

        return () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (timerRef.current) clearInterval(timerRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track first connect
    useEffect(() => {
        if (callState !== "CONNECTING" && !hasConnectedRef.current) {
            hasConnectedRef.current = true;
        }
    }, [callState]);

    // ── Format time MM:SS ───────────────────────────

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    // ── State label ─────────────────────────────────

    const stateLabel = (): string => {
        switch (callState) {
            case "CONNECTING": return initiator === "character" ? "来电..." : "正在呼叫...";
            case "IDLE": return isMuted ? "已静音" : "通话中";
            case "USER_SPEAKING": return "正在聆听...";
            case "PROCESSING": return "正在输入...";
            case "AI_SPEAKING": return "对方正在说话...";
            case "ENDED": return "通话已结束";
        }
    };

    // Barge-in（随时打断）：立刻中止当前 TTS 播放与浏览器语音合成，
    // 被打断的 AI 回复不再补播，后续由新的用户语音触发新回合。
    const bargeInAbort = useCallback(() => {
        bargeInRef.current = true;
        ttsEndedAtRef.current = Date.now();
        try { audioAbortRef.current?.(); } catch { /* 忽略中止异常 */ }
        audioAbortRef.current = null;
        if (window.speechSynthesis) {
            try { window.speechSynthesis.cancel(); } catch { /* 忽略 */ }
        }
    }, []);

    // ── AI response processing (same logic as chat-room) ──

    const processAIResponse = useCallback((aiResponseText: string): { cleanParts: string[]; stateValues: StateValue[] } => {
        // Use shared parseAIResponse for full rich media support (stickers, quotes, etc.)
        const previousState = getLatestCharacterStateValues(session.contactId);

        const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(aiResponseText, previousState);

        // 自定义状态栏渲染戳：不盖的话 custom 模式下 [状态栏] 原文按 markdown 渲染，看着像掉格式
        const statusRegionMode = statusPanel && isCustomStatusRegionActive(getStatusRegionConfig(session.id))
            ? ("custom" as const)
            : undefined;

        // Filter out non-chat action types (voice_call, video_call, poke, etc.)
        const chatParts = parts.filter(p =>
            !p.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(p.mediaType)
        );

        // Save messages to storage
        if (chatParts.length === 0 && (statusPanel || innerMonologue)) {
            const aiMsg = pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: "",
                statusPanel,
                statusRegionMode,
                innerMonologue,
                stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
            });
            messagesRef.current = [...messagesRef.current, aiMsg];
        } else {
            const newMsgs = chatParts.map((part, idx) =>
                pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    statusPanel: idx === 0 && statusPanel ? statusPanel : undefined,
                    statusRegionMode: idx === 0 && statusPanel ? statusRegionMode : undefined,
                    innerMonologue: idx === 0 && innerMonologue ? innerMonologue : undefined,
                    stateValues: idx === 0 && stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues: idx === 0 ? freshStateValues : undefined,
                })
            );
            messagesRef.current = [...messagesRef.current, ...newMsgs];
        }

        // Return clean text parts for TTS (exclude rich media content)
        const cleanParts = chatParts
            .filter(p => !p.mediaType && p.content.trim())
            .map(p => p.content);

        return { cleanParts, stateValues };
    }, [session.id, session.contactId]);

    // ── Full conversation turn ──────────────────────

    const runConversationTurn = useCallback(async (userText?: string) => {
        // 1. Save user message (skip for initial greeting)
        if (userText) {
            const userMsg = pushChatMessage({
                sessionId: session.id,
                role: "user",
                content: userText,
            });
            messagesRef.current = [...messagesRef.current, userMsg];

            // Add user subtitle
            setSubtitles(prev => [...prev, { id: userMsg.id, role: "user", text: userText }]);
            persistedSubIdsRef.current.add(userMsg.id);
        }

        // 2. Switch to PROCESSING
        setCallState("PROCESSING");
        setInterimText("");

        try {
            // 3. Generate AI response
            const aiResponseText = flattenCompletionResult(await generateChatCompletion(session, messagesRef.current, {
                appTags: ["chat", "voice"],
            }));

            // Bail if call ended during generation
            if (stateRef.current === "ENDED") return;

            // 4. Process response
            const { cleanParts } = processAIResponse(aiResponseText);
            const displayText = cleanParts.join("\n");
            const speechText = stripBilingualForSpeech(displayText);

            if (!displayText) {
                setCallState("IDLE");
                return;
            }

            // 5. Add AI subtitle
            const subtitleId = `ai-${Date.now()}`;
            setSubtitles(prev => [...prev, { id: subtitleId, role: "assistant", text: displayText }]);
            persistedSubIdsRef.current.add(subtitleId);

            // 缩小为悬浮窗期间收到的回复：只静默记录文字，不播放语音
            if (minimizedRef.current) {
                setCallState("IDLE");
                return;
            }

            // 6. TTS
            setCallState("AI_SPEAKING");

            const voiceConfig = resolveVoiceConfig(session.contactId);
            if (voiceConfig) {
                try {
                    const audioBlob = await synthesizeSpeech(speechText, voiceConfig);
                    if (stateRef.current === "ENDED") return;

                    if (audioBlob) {
                        const { promise, abort } = playCallAudio(audioBlob);
                        audioAbortRef.current = abort;
                        await promise;
                        audioAbortRef.current = null;
                        // 记录播完时间，后续 400ms 内的麦克风结果按扬声器回声忽略
                        ttsEndedAtRef.current = Date.now();
                    }
                } catch (e) {
                    console.warn("[VoiceCall] TTS failed:", e);
                }
            }

            // 收尾：未被打断且未挂断才回 IDLE；打断后状态留在 USER_SPEAKING，不得抢回
            if (stateRef.current !== "ENDED" && !bargeInRef.current) {
                setCallState("IDLE");
            }
            bargeInRef.current = false;
        } catch (error: any) {
            console.error("[VoiceCall] Error:", error);
            if (stateRef.current !== "ENDED") {
                setSubtitles(prev => [...prev, {
                    id: `err-${Date.now()}`,
                    role: "assistant",
                    text: `⚠️ ${error?.message || "发送失败"}`,
                }]);
                setCallState("IDLE");
            }
        }
    }, [session, processAIResponse, playCallAudio]);

    // ── Auto-listen: 进入 IDLE 自动开始监听 ────────

    const startListening = useCallback(() => {
        if (holdToTalk) return; // 按住说话模式不用 Web Speech 自动监听
        if (androidTextInputOnly && !huaweiNativeSttAvailable) {
            setInputMode("text");
            return;
        }
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setInterimText("");
        interimTextRef.current = "";

        const stt = createSTTSession({
            onInterim: (text) => {
                // TTS 刚结束 400ms 内视为扬声器回声，忽略不触发 barge-in
                if (Date.now() - ttsEndedAtRef.current < 400) return;
                setInterimText(text);
                interimTextRef.current = text;
                // 有中间结果 → 切到 USER_SPEAKING
                if (stateRef.current === "IDLE") {
                    setCallState("USER_SPEAKING");
                } else if (stateRef.current === "AI_SPEAKING") {
                    // Barge-in：AI 朗读时用户插话 → 立刻打断 TTS，进入用户说话态
                    bargeInAbort();
                    setCallState("USER_SPEAKING");
                }
            },
            onFinal: (text) => {
                sttRef.current = null;
                if (text.trim()) {
                    // 收尾帧兜底打断一次 TTS（interim 可能已打断过，幂等）
                    if (stateRef.current === "AI_SPEAKING") bargeInAbort();
                    runConversationTurn(text.trim());
                } else {
                    setInterimText("");
                    setCallState("IDLE");
                }
            },
            onError: (error) => {
                console.warn("[VoiceCall] STT error:", error);
                sttRef.current = null;
                setInterimText("");
                showSttCompatibilityWarning();
                // 严重错误，回到 IDLE（会触发重新监听）
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    setCallState("IDLE");
                }
            },
            onNoSpeech: () => {
                // 没检测到语音 → 静默重新开始监听
                sttRef.current = null;
                showSttCompatibilityWarning();
                if (stateRef.current === "IDLE" || stateRef.current === "USER_SPEAKING") {
                    // 短暂延迟后重启，避免快速循环
                    setTimeout(() => {
                        if (stateRef.current === "IDLE") {
                            startListening();
                        }
                    }, 300);
                }
            },
            onEnd: () => {
                // 没有 finalText 也没有 no-speech → 用 interimRef 兜底
                sttRef.current = null;
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    const fallback = interimTextRef.current;
                    if (fallback.trim()) {
                        runConversationTurn(fallback.trim());
                    } else {
                        setInterimText("");
                        setCallState("IDLE");
                    }
                }
            },
        }, "zh-CN");

        sttRef.current = stt;

        if (stt.isSupported) {
            stt.start();
        } else {
            sttRef.current = null;
            showSttCompatibilityWarning();
        }
    }, [androidTextInputOnly, holdToTalk, runConversationTurn, session.contactId, showSttCompatibilityWarning, bargeInAbort]);

    // IDLE 时自动开启监听（按住说话模式无自动监听，识别只在按住期间发生）
    useEffect(() => {
        if (holdToTalk) return;
        if (androidTextInputOnly) return;
        if (isMuted && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
            setInterimText("");
            return;
        }
        if ((callState === "IDLE" || callState === "AI_SPEAKING") && !isMuted && !minimized) {
            // 短暂延迟让 UI 过渡完成；AI 朗读期间也保持监听热，支持 barge-in 打断
            const timer = setTimeout(() => {
                if ((stateRef.current === "IDLE" || stateRef.current === "AI_SPEAKING") && !minimizedRef.current) {
                    startListening();
                }
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [androidTextInputOnly, holdToTalk, callState, isMuted, minimized, startListening]);

    const handleInputModeToggle = useCallback(() => {
        if (androidTextInputOnly) {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
        } else {
            setInputMode("voice");
        }
    }, [androidTextInputOnly, inputMode]);

    const handleTextSubmit = useCallback(() => {
        const text = typedText.trim();
        if (!text || callState !== "IDLE") return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setTypedText("");
        runConversationTurn(text);
    }, [typedText, callState, runConversationTurn]);

    // 输入框左侧的"重回"键：不发送新内容，直接让对方基于当前上下文重新回复一次
    const handleRegenerate = useCallback(() => {
        if (callState !== "IDLE") return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        runConversationTurn();
    }, [callState, runConversationTurn]);

    // 按住说话（非 iOS）：按下录音，松开转写后走对话轮
    const holdInput = useHoldToTalk({
        characterId: session.contactId,
        canStart: () => stateRef.current === "IDLE",
        onRecordingStart: () => {
            setInterimText("");
            if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
        },
        onTranscribeStart: () => {
            if (stateRef.current === "USER_SPEAKING") setCallState("PROCESSING");
        },
        onTranscript: (text) => { void runConversationTurn(text); },
        onError: () => {
            if (stateRef.current === "USER_SPEAKING" || stateRef.current === "PROCESSING") {
                setCallState("IDLE");
            }
        },
    });

    // ── 华为原生语音：免提直说 + 按住说话（免云端，结果经 __floatBridgeOnSpeechText 回传） ──

    const huaweiNativeStartTalk = useCallback(() => {
        try {
            const shell = getAndroidShell();
            if (!shell || typeof shell.startListening !== "function") return;
            const settings = loadHuaweiShellSettings();
            const mode = settings.sttMode === "cloud" ? "system" : settings.sttMode;
            shell.startListening(JSON.stringify({
                mode,
                url: settings.sttOnlineUrl,
                key: settings.sttOnlineKey,
                model: settings.sttOnlineModel,
            }));
        } catch { /* 忽略启动失败 */ }
    }, []);

    const huaweiNativeStopTalk = useCallback(() => {
        try {
            const shell = getAndroidShell();
            if (shell && typeof shell.stopListening === "function") shell.stopListening();
        } catch { /* 忽略 */ }
    }, []);

    const huaweiTalkHandlers = {
        onPointerDown: () => {
            if (stateRef.current !== "IDLE") return;
            setCallState("USER_SPEAKING");
            huaweiNativeStartTalk();
        },
        onPointerUp: () => {
            if (stateRef.current !== "USER_SPEAKING" && stateRef.current !== "PROCESSING") return;
            setCallState("PROCESSING");
            huaweiNativeStopTalk();
        },
        onPointerCancel: () => {
            if (stateRef.current !== "USER_SPEAKING" && stateRef.current !== "PROCESSING") return;
            setCallState("PROCESSING");
            huaweiNativeStopTalk();
        },
    };

    // 原生识别结果回传：通话中免提直说 / 按住说话的识别文本 → 直接走对话轮（不做转文字展示）
    useEffect(() => {
        if (!huaweiNativeSttAvailable) return;
        const w = window as unknown as { __floatBridgeOnSpeechText?: (json: string) => void };
        const handler = (json: string) => {
            let text = "";
            try {
                const parsed = JSON.parse(json) as { text?: string; ok?: boolean; error?: string };
                if (parsed.ok && typeof parsed.text === "string" && parsed.text.trim()) text = parsed.text.trim();
            } catch { /* 非法回传忽略 */ }
            // TTS 刚结束 400ms 内的回传文本视为扬声器回声，忽略
            if (text && Date.now() - ttsEndedAtRef.current < 400) text = "";
            if (!text) {
                if (stateRef.current === "PROCESSING" || stateRef.current === "USER_SPEAKING" || stateRef.current === "AI_SPEAKING") setCallState("IDLE");
                return;
            }
            if (stateRef.current === "AI_SPEAKING") {
                // Barge-in：原生长连监听到人声 → 立刻停 TTS，不等待播完
                bargeInAbort();
                setCallState("USER_SPEAKING");
            }
            if (stateRef.current === "PROCESSING" || stateRef.current === "USER_SPEAKING" || stateRef.current === "AI_SPEAKING") setCallState("IDLE");
            void runConversationTurn(text);
        };
        const prev = w.__floatBridgeOnSpeechText;
        const ourHandler = (json: string) => {
            handler(json);
            if (typeof prev === "function") { try { prev(json); } catch { /* 忽略 */ } }
        };
        w.__floatBridgeOnSpeechText = ourHandler;
        return () => {
            // 仅当监听者仍是本组件安装的包装函数时才恢复原监听者，避免误删其他监听者
            if (w.__floatBridgeOnSpeechText === ourHandler) {
                w.__floatBridgeOnSpeechText = (typeof prev === "function" ? prev : undefined);
            }
        };
    }, [runConversationTurn, bargeInAbort]);

    // 华为壳免提直说：接通进入 IDLE 后自动开麦，说完一段由原生经
    // __floatBridgeOnSpeechText 回传文本并自动走对话轮；静音/缩小/挂断时停麦。
    // 不可用时此 effect 整体不生效，回落 Web Speech 自动监听 / 按住说话。
    useEffect(() => {
        if (!huaweiNativeSttAvailable) return;
        if (isMuted) {
            huaweiNativeStopTalk();
            return;
        }
        if (minimized) return;
        // 只在等 AI 网络回复（PROCESSING）时不重开监听；IDLE / AI_SPEAKING 都保持长连监听，
        // AI 朗读时麦克风保持热，随时可 barge-in 打断。
        // TODO: 若原生桥实测不支持边播边录，此处需回落到 Web Speech / MediaRecorder 做 VAD 打断检测。
        if (callState === "PROCESSING") return;
        const t = setTimeout(() => {
            if ((stateRef.current === "IDLE" || stateRef.current === "AI_SPEAKING") && !minimizedRef.current && !mutedRef.current) {
                huaweiNativeStartTalk();
            }
        }, 500);
        return () => clearTimeout(t);
    }, [callState, minimized, isMuted, huaweiNativeStartTalk, huaweiNativeStopTalk]);

    // ── Hangup ──────────────────────────────────────

    const handleHangup = useCallback(() => {
        setCallState("ENDED");
        try {
            const shell = getAndroidShell();
            if (shell && typeof shell.stopRing === "function") shell.stopRing();
        } catch { /* 忽略 */ }
        try {
            const shell = getAndroidShell();
            if (shell && typeof shell.stopListening === "function") shell.stopListening();
        } catch { /* 忽略 */ }

        // Stop any ongoing STT
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }

        // Stop any ongoing audio playback
        if (audioAbortRef.current) {
            audioAbortRef.current();
            audioAbortRef.current = null;
        }

        // Stop browser TTS
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }

        // 挂断前补齐还在字幕状态机里、没落库的真实对话轮次
        flushUnpersistedSubtitles();

        const endMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: `[我挂断了语音通话]`,
            mediaData: { callDuration: formatTime(callDuration) },
        });
        messagesRef.current = [...messagesRef.current, endMsg];

        // Delay then close
        setTimeout(() => onEnd(), 1500);
    }, [session.id, callDuration, onEnd, flushUnpersistedSubtitles]);

    // ── Render ──────────────────────────────────────

    if (minimized) {
        return (
            <button
                type="button"
                className="call-mini-window"
                style={{ backgroundImage: `url(${bgImageResolved || character.avatar || ""})` }}
                onClick={onRestore}
                aria-label={`返回与${character.name}的语音通话`}
                title="点击返回通话"
            >
                <span className="call-mini-window-overlay" />
                <span className="call-mini-window-name">{character.name}</span>
            </button>
        );
    }

    return (
        <div
            className="vcsx-root call-keyboard-shift"
            style={keyboardOffsetStyle}
        >
            <style>{VCSX_STYLE}</style>
            {/* 朦胧光斑 + 自定义通话背景 */}
            <div className="vcsx-glow vcsx-glow-a" />
            <div className="vcsx-glow vcsx-glow-b" />
            {bgImageResolved && (
                <div className="vcsx-bgimg" style={{ backgroundImage: "url(" + bgImageResolved + ")" }} />
            )}

            <CallVolumeControl />

            {onMinimize && callState !== "ENDED" && (
                <button
                    type="button"
                    className="vcsx-min-btn"
                    onClick={onMinimize}
                    aria-label="缩小通话"
                    title="缩小通话"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                </button>
            )}

            <button
                type="button"
                className="vcsx-min-btn"
                style={{ left: "auto", right: 14, top: "max(14px, env(safe-area-inset-top))", zIndex: 100, width: 48, height: 48, pointerEvents: "auto" }}
                onClick={() => setShowCallSettings(true)}
                aria-label="通话设置"
                title="通话外观设置"
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
            </button>

            {/* 顶部居中：来电铃声滚动 / 通话计时 */}
            <div className="vcsx-topline">
                {callState === "CONNECTING" && initiator === "character" ? (
                    <div className="vcsx-ringnow">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="#a8d8ff">
                            <path d="M9 18.5a3 3 0 1 1-2-2.83V5.5l11-2v10.17a3 3 0 1 1-2-2.83V7.5L9 9.17v9.33z" />
                        </svg>
                        <div className="vcsx-ringmarquee">
                            <div className="vcsx-ringtrack">
                                <span className="vcsx-ringitem">叮铃铃 — {character.name}找你有事 — </span>
                                <span className="vcsx-ringitem" aria-hidden="true">叮铃铃 — {character.name}找你有事 — </span>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="vcsx-timer">
                        {callState !== "CONNECTING" && callState !== "ENDED" ? formatTime(callDuration) : ""}
                    </div>
                )}
            </div>

            {/* 中部：头像 + 名字 + 状态 + 气泡 */}
            <div className="vcsx-main">
                <div className="vcsx-avatar-wrap">
                    <div className="vcsx-avatar">
                        {callAvatar ? (
                            <img src={callAvatar} alt={character.name} />
                        ) : (
                            <span className="vcsx-avatar-fallback">
                                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                    <circle cx="12" cy="7" r="4" />
                                </svg>
                            </span>
                        )}
                    </div>
                    {callState === "CONNECTING" && (
                        <>
                            <span className="vcsx-ring-pulse" />
                            <span className="vcsx-ring-pulse vcsx-ring-pulse-delay" />
                        </>
                    )}
                    {callState === "AI_SPEAKING" && <span className="vcsx-speaking-ring" />}
                </div>

                <div className="vcsx-name">{character.name}</div>

                <div className="vcsx-status">
                    <span>
                        {stateLabel()}
                        {callState !== "CONNECTING" && callState !== "ENDED" ? " · " + formatTime(callDuration) : ""}
                    </span>
                    {callState === "AI_SPEAKING" && (
                        <span className="vcsx-wave" aria-hidden="true">
                            <i /><i /><i /><i /><i />
                        </span>
                    )}
                </div>

                {/* 字幕气泡区：用户靠右、AI 靠左，最新一条高亮 */}
                <div ref={subtitleScrollRef} className="vcsx-bubbles">
                    {subtitles.map((sub) => (
                        <div
                            key={sub.id}
                            className={
                                "vcsx-bubble " +
                                (sub.role === "user" ? "vcsx-bubble-user" : "vcsx-bubble-ai") +
                                (sub.id === subtitles[subtitles.length - 1]?.id ? " vcsx-bubble-latest" : "")
                            }
                        >
                            <BilingualTextBlock
                                text={sub.text}
                                mode="plain"
                                className="vcsx-bubble-text"
                                defaultExpanded={session.collapseBilingualTranslation !== false ? false : true}
                            />
                        </div>
                    ))}
                    {interimText && callState === "USER_SPEAKING" && (
                        <div className="vcsx-bubble vcsx-bubble-user vcsx-bubble-interim">{interimText}</div>
                    )}
                </div>
            </div>

            {/* 文字输入面板：通话中始终保留，语音/打字并存不强制切换 */}
            {callState !== "CONNECTING" && callState !== "ENDED" && (
                <form
                    className="call-text-input-panel voicecall-text-input-panel call-text-input-row"
                    onSubmit={(e) => { e.preventDefault(); handleTextSubmit(); }}
                >
                    <button
                        type="button"
                        onClick={handleRegenerate}
                        className="call-regenerate-btn"
                        disabled={callState !== "IDLE"}
                        aria-label="让对方重新回复"
                        title="让对方重新回复"
                    >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M23 4v6h-6" />
                            <path d="M1 20v-6h6" />
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                        </svg>
                    </button>
                    <div className="call-text-input-shell">
                        <input
                            value={typedText}
                            onChange={(e) => setTypedText(e.target.value)}
                            className="call-text-input"
                            placeholder={callState === "IDLE" ? "输入你想说的话..." : "稍等对方说完..."}
                            disabled={callState !== "IDLE"}
                        />
                        <button
                            type="submit"
                            className="call-text-send-btn"
                            disabled={!typedText.trim() || callState !== "IDLE"}
                            aria-label="发送"
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 19V5" />
                                <path d="M5 12l7-7 7 7" />
                            </svg>
                        </button>
                    </div>
                </form>
            )}

            {/* 按住说话提示（回落） */}
            {holdToTalk && inputMode === "voice" && callState !== "CONNECTING" && callState !== "ENDED" && (
                <div className="vcsx-hold-hint">
                    {holdInput.recState === "recording" ? "松开发送"
                        : holdInput.recState === "transcribing" ? "识别中…"
                        : holdInput.error || "按住下方麦克风说话"}
                </div>
            )}

            {/* 底部控制栏 */}
            <div className="vcsx-controls" style={{ paddingBottom: "max(28px, env(safe-area-inset-bottom))" }}>
                {callState === "ENDED" ? (
                    <div className="vcsx-ended">通话已结束</div>
                ) : callState === "CONNECTING" && initiator === "character" ? (
                    <>
                        <button
                            type="button"
                            className="vcsx-fab"
                            onClick={() => {
                                pushChatMessage({ sessionId: session.id, role: "user", content: "[我拒绝了语音通话]" });
                                onEnd();
                            }}
                        >
                            <span className="vcsx-fab-circle vcsx-fab-hang-circle">
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                </svg>
                            </span>
                            <span className="vcsx-fab-label">拒绝</span>
                        </button>
                        <button
                            type="button"
                            className="vcsx-fab"
                            onClick={() => setCallState("IDLE")}
                        >
                            <span className="vcsx-fab-circle vcsx-fab-accept-circle">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                                </svg>
                            </span>
                            <span className="vcsx-fab-label">接听</span>
                        </button>
                    </>
                ) : callState === "CONNECTING" ? (
                    <button
                        type="button"
                        className="vcsx-fab"
                        onClick={() => {
                            pushChatMessage({ sessionId: session.id, role: "user", content: "[我取消了语音通话]" });
                            onEnd();
                        }}
                    >
                        <span className="vcsx-fab-circle vcsx-fab-hang-circle">
                            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="6" y1="6" x2="18" y2="18" />
                                <line x1="18" y1="6" x2="6" y2="18" />
                            </svg>
                        </span>
                        <span className="vcsx-fab-label">取消</span>
                    </button>
                ) : holdToTalk ? (
                    <>
                        <button
                            type="button"
                            className="vcsx-fab"
                            onClick={handleInputModeToggle}
                            aria-label={inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                        >
                            <span className="vcsx-fab-circle vcsx-fab-default-circle">
                                {inputMode === "voice" ? (
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                ) : (
                                    <span className="vcsx-fab-text-icon">Aa</span>
                                )}
                            </span>
                            <span className="vcsx-fab-label">{inputMode === "voice" ? "文字" : "语音"}</span>
                        </button>
                        <button
                            type="button"
                            className="vcsx-fab"
                            style={{ touchAction: "none" }}
                            aria-label={inputMode === "text" ? "切换到语音输入" : "按住说话"}
                            {...(inputMode === "voice" ? (huaweiNativeSttAvailable ? huaweiTalkHandlers : holdInput.pressHandlers) : { onClick: handleInputModeToggle })}
                        >
                            <span className="vcsx-fab-circle vcsx-fab-mic-circle">
                                {inputMode === "text" ? (
                                    <span className="vcsx-fab-text-icon">Aa</span>
                                ) : (
                                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </span>
                            <span className="vcsx-fab-label">{inputMode === "text" ? "语音" : "按住说话"}</span>
                        </button>
                        <button type="button" className="vcsx-fab" onClick={handleHangup} aria-label="挂断">
                            <span className="vcsx-fab-circle vcsx-fab-hang-circle">
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                </svg>
                            </span>
                            <span className="vcsx-fab-label">挂断</span>
                        </button>
                    </>
                ) : androidTextInputOnly ? (
                    <button type="button" className="vcsx-fab" onClick={handleHangup} aria-label="挂断">
                        <span className="vcsx-fab-circle vcsx-fab-hang-circle">
                            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="6" y1="6" x2="18" y2="18" />
                                <line x1="18" y1="6" x2="6" y2="18" />
                            </svg>
                        </span>
                        <span className="vcsx-fab-label">挂断</span>
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            className="vcsx-fab"
                            onClick={() => setIsMuted(!isMuted)}
                            aria-label={isMuted ? "取消静音" : "静音"}
                        >
                            <span className={"vcsx-fab-circle " + (isMuted ? "vcsx-fab-muted-on-circle" : "vcsx-fab-default-circle")}>
                                {isMuted ? (
                                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.15" />
                                        <line x1="12" y1="19" x2="12" y2="23" />
                                    </svg>
                                ) : (
                                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </span>
                            <span className="vcsx-fab-label">{isMuted ? "取消静音" : "静音"}</span>
                        </button>
                        <button type="button" className="vcsx-fab" onClick={handleHangup} aria-label="挂断">
                            <span className="vcsx-fab-circle vcsx-fab-hang-circle">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                </svg>
                            </span>
                            <span className="vcsx-fab-label">挂断</span>
                        </button>
                    </>
                )}
            </div>

            {!androidTextInputOnly && showSttWarning && (
                <CallSttWarningDialog
                    onClose={() => setShowSttWarning(false)}
                    onNeverShow={handleNeverShowSttWarning}
                />
            )}

            {showCallSettings && (
                <CallAppearanceSettings
                    characterId={session.contactId}
                    characterName={character.name}
                    onClose={() => setShowCallSettings(false)}
                />
            )}
        </div>
    );
}

const VCSX_STYLE = `
.vcsx-root {
    position: absolute; inset: 0; z-index: 100; overflow: hidden;
    display: flex; flex-direction: column; color: #fff;
    font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif;
    background: radial-gradient(120% 80% at 50% 0%, #1a2f4e 0%, #0a1628 55%, #060d1a 100%);
}
.vcsx-glow { position: absolute; border-radius: 50%; filter: blur(60px); opacity: .5; pointer-events: none; z-index: 0; }
.vcsx-glow-a { width: 320px; height: 320px; top: -80px; left: -60px; background: radial-gradient(circle, rgba(126,200,255,.35), transparent 70%); animation: vcsxDrift 9s ease-in-out infinite alternate; }
.vcsx-glow-b { width: 360px; height: 360px; bottom: -100px; right: -80px; background: radial-gradient(circle, rgba(168,216,255,.22), transparent 70%); animation: vcsxDrift 11s ease-in-out infinite alternate-reverse; }
@keyframes vcsxDrift { from { transform: translate(0,0) scale(1); } to { transform: translate(30px,20px) scale(1.12); } }
.vcsx-bgimg { position: absolute; inset: 0; background-size: cover; background-position: center; opacity: .32; filter: blur(2px); z-index: 0; }
.vcsx-min-btn {
    position: absolute; top: max(14px, env(safe-area-inset-top)); left: 14px; z-index: 5;
    width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.1); color: #fff;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
}
.vcsx-text-toggle {
    position: absolute; top: max(16px, env(safe-area-inset-top)); right: 16px; z-index: 5;
    padding: 7px 14px; border-radius: 999px; font-size: 13px; cursor: pointer;
    border: 1px solid rgba(168,216,255,.35); background: rgba(126,200,255,.14); color: #cfe9ff;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
}
.vcsx-topline {
    position: relative; z-index: 2; height: 56px;
    padding-top: max(16px, env(safe-area-inset-top));
    display: flex; align-items: center; justify-content: center;
}
.vcsx-timer { font-size: 15px; letter-spacing: 2px; color: rgba(255,255,255,.85); font-variant-numeric: tabular-nums; min-height: 20px; }
.vcsx-ringnow {
    display: flex; align-items: center; gap: 6px; max-width: 80%;
    background: rgba(10,22,40,.55); border: 1px solid rgba(168,216,255,.25);
    border-radius: 999px; padding: 6px 14px;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
}
.vcsx-ringmarquee { overflow: hidden; width: 190px; }
.vcsx-ringtrack { display: flex; width: max-content; animation: vcsxMarquee 9s linear infinite; }
.vcsx-ringitem { white-space: nowrap; font-size: 12px; color: #a8d8ff; padding-right: 40px; }
@keyframes vcsxMarquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.vcsx-main { position: relative; z-index: 1; flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; padding: 6px 20px 0; }
.vcsx-avatar-wrap { position: relative; margin-top: 14px; }
.vcsx-avatar {
    position: relative; width: 112px; height: 112px; border-radius: 50%; overflow: hidden;
    background: linear-gradient(135deg, #7ec8ff, #a8d8ff);
    box-shadow: 0 12px 40px rgba(126,200,255,.25), 0 0 0 3px rgba(255,255,255,.12);
    display: flex; align-items: center; justify-content: center;
}
.vcsx-avatar img { width: 100%; height: 100%; object-fit: cover; }
.vcsx-avatar-fallback { font-size: 44px; font-weight: 700; color: #0a1628; }
.vcsx-ring-pulse { position: absolute; inset: -10px; border-radius: 50%; border: 2px solid rgba(168,216,255,.4); pointer-events: none; animation: vcsxRingPulse 1.6s ease-out infinite; }
.vcsx-ring-pulse-delay { animation-delay: .8s; }
@keyframes vcsxRingPulse { 0% { transform: scale(.95); opacity: .8; } 100% { transform: scale(1.35); opacity: 0; } }
.vcsx-speaking-ring { position: absolute; inset: -8px; border-radius: 50%; border: 2px solid rgba(126,200,255,.6); pointer-events: none; animation: vcsxSpeak 1.2s ease-in-out infinite; }
@keyframes vcsxSpeak { 0%, 100% { transform: scale(1); opacity: .5; } 50% { transform: scale(1.12); opacity: .9; } }
.vcsx-name { margin-top: 16px; font-size: 22px; font-weight: 600; letter-spacing: 1px; text-shadow: 0 2px 12px rgba(0,0,0,.4); }
.vcsx-status { margin-top: 8px; min-height: 22px; font-size: 14px; color: rgba(207,233,255,.85); display: flex; align-items: center; gap: 8px; }
.vcsx-wave { display: inline-flex; align-items: flex-end; gap: 3px; height: 14px; }
.vcsx-wave i { width: 3px; border-radius: 2px; background: #7ec8ff; transform-origin: bottom; animation: vcsxWave 1s ease-in-out infinite; }
.vcsx-wave i:nth-child(1) { height: 6px; }
.vcsx-wave i:nth-child(2) { height: 12px; animation-delay: .15s; }
.vcsx-wave i:nth-child(3) { height: 8px; animation-delay: .3s; }
.vcsx-wave i:nth-child(4) { height: 13px; animation-delay: .45s; }
.vcsx-wave i:nth-child(5) { height: 7px; animation-delay: .6s; }
@keyframes vcsxWave { 0%, 100% { transform: scaleY(.4); } 50% { transform: scaleY(1); } }
.vcsx-bubbles {
    margin-top: 18px; width: 100%; max-width: 440px; flex: 1; min-height: 0; overflow-y: auto;
    display: flex; flex-direction: column; gap: 10px; padding-bottom: 10px;
    mask-image: linear-gradient(to bottom, transparent 0, #000 24px);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 24px);
}
.vcsx-bubble {
    max-width: 78%; padding: 10px 14px; font-size: 15px; line-height: 1.55; word-break: break-word;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    animation: vcsxRise .35s ease;
}
@keyframes vcsxRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.vcsx-bubble-ai { align-self: flex-start; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.16); border-radius: 20px; border-bottom-left-radius: 6px; color: #eaf6ff; }
.vcsx-bubble-user { align-self: flex-end; background: rgba(126,200,255,.22); border: 1px solid rgba(168,216,255,.4); border-radius: 20px; border-bottom-right-radius: 6px; color: #fff; }
.vcsx-bubble-latest { box-shadow: 0 0 0 1px rgba(168,216,255,.35), 0 8px 24px rgba(126,200,255,.15); }
.vcsx-bubble-interim { opacity: .75; }
.vcsx-hold-hint { position: relative; z-index: 2; text-align: center; font-size: 12px; opacity: .8; padding: 4px 20px 0; }
.vcsx-controls { position: relative; z-index: 2; display: flex; justify-content: center; align-items: flex-start; gap: 44px; padding: 18px 20px 0; }
.vcsx-fab { display: flex; flex-direction: column; align-items: center; gap: 8px; background: none; border: none; cursor: pointer; color: #fff; }
.vcsx-fab-circle {
    width: 66px; height: 66px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    transition: transform .12s ease;
}
.vcsx-fab:active .vcsx-fab-circle { transform: scale(.92); }
.vcsx-fab-label { font-size: 12px; color: rgba(255,255,255,.75); }
.vcsx-fab-default-circle { background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.25); box-shadow: 0 8px 24px rgba(0,0,0,.3); }
.vcsx-fab-muted-on-circle { background: rgba(255,59,48,.9); border: 1px solid rgba(255,120,110,.6); box-shadow: 0 8px 24px rgba(255,59,48,.4); }
.vcsx-fab-mic-circle { background: rgba(126,200,255,.22); border: 1px solid rgba(168,216,255,.5); width: 72px; height: 72px; box-shadow: 0 8px 28px rgba(126,200,255,.3); }
.vcsx-fab-hang-circle { width: 72px; height: 72px; background: #ff3b30; border: none; box-shadow: 0 10px 30px rgba(255,59,48,.45); }
.vcsx-fab-accept-circle { width: 72px; height: 72px; background: #34c759; border: none; box-shadow: 0 10px 30px rgba(52,199,89,.45); }
.vcsx-fab-text-icon { font-size: 22px; font-weight: 700; }
.vcsx-ended { font-size: 14px; color: rgba(255,255,255,.6); padding-top: 20px; }
`;
