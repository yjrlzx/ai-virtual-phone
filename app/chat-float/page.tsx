"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import {
    generateMascotReply,
    getMascotChatSnapshot,
    hydrateMascotChat,
    sendMascotMessage,
    stopMascotGeneration,
    subscribeMascotChat,
} from "@/lib/mascot-chat-store";
import type { MascotMsg } from "@/lib/mascot-engine";
import {
    DEFAULT_MASCOT_DISPLAY_NAME,
    getMascotSettingsSnapshot,
    subscribeMascotSettings,
} from "@/lib/mascot-settings";
import { BilingualTextBlock } from "@/components/chat/message-bubble";
import { CHAT_APP_SETTINGS_UPDATED_EVENT, loadChatAppSettings } from "@/lib/chat-storage";
import { shouldSendChatInputOnEnter } from "@/lib/chat-input-keyboard";

// 与 components/chat/mascot-chat-room.tsx 保持一致的消息过滤规则：
// tool 消息与「（调用工具中…）/（无内容）」占位气泡不在悬浮窗里展示。
function isHiddenMascotPlaceholder(msg: MascotMsg): boolean {
    return msg.role === "mascot"
        && !!msg.displayText
        && /^（(调用工具中|无内容)/.test(msg.displayText);
}

function getMascotMessageText(msg: MascotMsg | undefined): string {
    return msg?.displayText || msg?.text || "";
}

function getVisibleMessages(messages: MascotMsg[]): MascotMsg[] {
    return messages.filter((msg) => !msg.hidden && msg.role !== "tool" && !isHiddenMascotPlaceholder(msg));
}

export default function ChatFloatPage() {
    const chat = useSyncExternalStore(subscribeMascotChat, getMascotChatSnapshot, getMascotChatSnapshot);
    const settings = useSyncExternalStore(subscribeMascotSettings, getMascotSettingsSnapshot, getMascotSettingsSnapshot);

    const [inputText, setInputText] = useState("");
    const [enterToSend, setEnterToSend] = useState(
        () => loadChatAppSettings().enterToSendEnabled === true,
    );
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // 独立 WebView：与主页面同源共享 IndexedDB，需自行触发 hydrate 把角色历史加载进来。
    useEffect(() => {
        void hydrateMascotChat();
    }, []);

    useEffect(() => {
        const sync = () => setEnterToSend(loadChatAppSettings().enterToSendEnabled === true);
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, sync);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, sync);
    }, []);

    const visibleMessages = useMemo(() => getVisibleMessages(chat.messages), [chat.messages]);
    const latestVisible = [...chat.messages].reverse().find((msg) => !msg.hidden && msg.role !== "tool");
    const canGenerateReply = !chat.isThinking && latestVisible?.role === "user";

    // 自动滚到底：历史加载完成、新消息、流式增量、思考态切换时都要贴底。
    const scrollSignature = useMemo(() => {
        const last = visibleMessages[visibleMessages.length - 1];
        return [
            visibleMessages.length,
            chat.isThinking ? 1 : 0,
            last?.role ?? "",
            getMascotMessageText(last).length,
        ].join(":");
    }, [visibleMessages, chat.isThinking]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !chat.hydrated) return;
        el.scrollTop = el.scrollHeight;
    }, [chat.hydrated, scrollSignature]);

    const resizeTextarea = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 100) + "px";
    }, []);

    const handleSend = useCallback(async () => {
        if (chat.isThinking) {
            stopMascotGeneration();
            return;
        }
        const text = inputText.trim();
        if (!text) return;
        setInputText("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        // 复用主聊天同一发送通道：append + 流式 generate，回包通过 store 订阅自动追加。
        await sendMascotMessage({ text });
    }, [chat.isThinking, inputText]);

    const handleRegenerate = useCallback(async () => {
        if (!canGenerateReply) return;
        await generateMascotReply();
    }, [canGenerateReply]);

    const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (shouldSendChatInputOnEnter(event, enterToSend)) {
            event.preventDefault();
            if (chat.isThinking) return;
            void handleSend();
        }
    }, [enterToSend, chat.isThinking, handleSend]);

    const nickname = settings.nickname || DEFAULT_MASCOT_DISPLAY_NAME;

    // 角色对话被用户关闭（mascot settings chatEnabled=false）：给一个真实的「选择角色」入口，
    // 跳主站角色页。同 host 链接会被壳留在小窗 WebView 内。
    if (!settings.chatEnabled) {
        return (
            <div style={{
                position: "fixed", inset: 0, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 12, padding: 24,
                background: "var(--c-page-body-bg)", color: "var(--c-text)",
                textAlign: "center", fontSize: 14,
            }}>
                <p style={{ margin: 0, opacity: 0.7 }}>尚未开启角色对话</p>
                <a
                    href="/characters"
                    style={{
                        color: "var(--c-icon-active, #4f8cff)",
                        textDecoration: "underline", fontSize: 14,
                    }}
                >
                    去角色中心选择角色
                </a>
            </div>
        );
    }

    return (
        <div style={{
            position: "fixed", inset: 0, display: "flex", flexDirection: "column",
            overflow: "hidden", background: "var(--c-page-body-bg)",
            color: "var(--c-text)",
        }}>
            {/* 极简标题栏：原生壳已有标题栏，这里只显示角色名 + 在线态 */}
            <div style={{
                flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8,
                padding: "6px 12px", borderBottom: "0.5px solid var(--c-input-border, rgba(128,128,128,0.25))",
                fontSize: 13, fontWeight: 600,
            }}>
                <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {nickname}
                </span>
                <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    fontSize: 11, fontWeight: 400, opacity: 0.7,
                }}>
                    <span style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: chat.isThinking ? "#e0a73a" : "#4caf50",
                    }} />
                    {chat.isThinking ? "思考中" : "在线"}
                </span>
            </div>

            {/* 消息列表：user 靠右 / mascot 靠左（全局 .chat-msg-wrapper[data-role] 已处理对齐） */}
            <div
                ref={scrollRef}
                style={{
                    flex: "1 1 auto", overflowY: "auto", overflowX: "hidden",
                    padding: "12px 12px 8px", display: "flex", flexDirection: "column", gap: 10,
                }}
            >
                {visibleMessages.length === 0 && chat.hydrated && (
                    <div style={{ margin: "auto", opacity: 0.5, fontSize: 13, textAlign: "center" }}>
                        和{nickname}说点什么吧
                    </div>
                )}

                {visibleMessages.map((msg, index) => {
                    const isUser = msg.role === "user";
                    const text = getMascotMessageText(msg);
                    return (
                        <div
                            key={`${index}-${msg.createdAt || ""}`}
                            className="chat-msg-wrapper"
                            data-role={isUser ? "user" : "assistant"}
                            style={{ gap: 0 }}
                        >
                            <div className="chat-msg-content-wrap flex flex-col min-w-0" style={{ maxWidth: "82%" }}>
                                <div
                                    className={`${isUser ? "chat-bubble-role-user" : "chat-bubble-role-assistant chat-bubble-role-mascot"} rounded-md break-words`}
                                    data-ui={isUser ? "bubble-user" : "bubble-bot"}
                                >
                                    {text ? (
                                        <BilingualTextBlock text={text} mode="markdown" defaultExpanded />
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {chat.isThinking && visibleMessages.length > 0 && (
                    <div className="chat-msg-wrapper" data-role="assistant" style={{ gap: 0 }}>
                        <div className="chat-bubble-role-assistant chat-bubble-role-mascot rounded-md mascot-thinking">
                            思考中<span className="mascot-dot"></span><span className="mascot-dot"></span><span className="mascot-dot"></span>
                        </div>
                    </div>
                )}

                {canGenerateReply && (
                    <div style={{ textAlign: "center" }}>
                        <button
                            type="button"
                            onClick={() => void handleRegenerate()}
                            style={{
                                background: "none", border: "1px solid var(--c-input-border, rgba(128,128,128,0.3))",
                                borderRadius: 14, padding: "4px 12px", fontSize: 12,
                                color: "var(--c-text)", cursor: "pointer",
                            }}
                        >
                            重新生成回复
                        </button>
                    </div>
                )}
            </div>

            {/* 底部输入区：flex 列布局末尾，软键盘弹起 resize 时自动顶在可视区底部 */}
            <div style={{
                flex: "0 0 auto", display: "flex", alignItems: "flex-end", gap: 8,
                padding: "8px 10px",
                paddingBottom: "max(8px, env(safe-area-inset-bottom, 0px))",
                borderTop: "0.5px solid var(--c-input-border, rgba(128,128,128,0.25))",
            }}>
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={inputText}
                    onChange={(event) => {
                        setInputText(event.target.value);
                        resizeTextarea();
                    }}
                    onKeyDown={handleKeyDown}
                    enterKeyHint={enterToSend ? "send" : "enter"}
                    className="chat-input-textarea"
                    placeholder={`跟${nickname}聊聊...`}
                    style={{ flex: "1 1 auto", resize: "none", padding: "8px 10px", fontSize: 14, lineHeight: 1.4 }}
                />
                <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={!chat.isThinking && !inputText.trim()}
                    aria-label={chat.isThinking ? "停止生成" : "发送"}
                    style={{
                        flex: "0 0 auto", alignSelf: "flex-end",
                        width: 38, height: 38, borderRadius: "50%", border: "none",
                        background: "var(--c-icon-active, #4f8cff)", color: "#fff",
                        fontSize: 16, lineHeight: 1, cursor: "pointer",
                        opacity: !chat.isThinking && !inputText.trim() ? 0.4 : 1,
                    }}
                >
                    {chat.isThinking ? "■" : "↑"}
                </button>
            </div>
        </div>
    );
}
