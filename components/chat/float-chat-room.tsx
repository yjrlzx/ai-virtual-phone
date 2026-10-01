"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  hydrateChatStorage,
  createOrGetSession,
  loadChatMessages,
  pushChatMessage,
  type ChatMessage,
  type ChatSession,
} from "@/lib/chat-storage";
import {
  generateChatCompletion,
  ChatEngineError,
} from "@/lib/chat-engine";
import {
  LUZHIXING_CHARACTER_ID,
  seedLuzhixingIfFirstRun,
} from "@/lib/luzhixing-seed";

// 精简悬浮窗聊天：固定和陆知行聊，走主聊天同一套 LLM 引擎
export function FloatChatRoom() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const sessionRef = useRef<ChatSession | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [messages, streaming]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await hydrateChatStorage();
        await seedLuzhixingIfFirstRun();
        const session = createOrGetSession(LUZHIXING_CHARACTER_ID);
        if (cancelled) return;
        sessionRef.current = session;
        setMessages(loadChatMessages(session.id, 60));
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "初始化失败");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    const session = sessionRef.current;
    if (!text || thinking || !session) return;
    setInput("");
    setError("");
    setThinking(true);
    setStreaming("");

    // 1. 用户消息落库
    const userMsg = pushChatMessage({
      sessionId: session.id,
      role: "user",
      content: text,
    });
    setMessages((m) => [...m, userMsg]);

    try {
      // 2. 从存储重载历史（保证引擎看到的是落库后的完整上下文）
      const history = loadChatMessages(session.id, 80);

      // 3. 走和主聊天完全相同的生成入口
      await generateChatCompletion(
        session,
        history,
        { appTags: ["chat", "text"] },
        {
          onStreamDelta: (delta) => {
            setStreaming((prev) => prev + delta);
          },
          onTextPart: async (partText) => {
            setStreaming("");
            const finalText = (partText || "").trim();
            if (!finalText) return;
            // 4. 助手回复落库，和主聊天共享同一份历史
            const aiMsg = pushChatMessage({
              sessionId: session.id,
              role: "assistant",
              content: finalText,
            });
            setMessages((m) => [...m, aiMsg]);
          },
        }
      );
    } catch (e) {
      setStreaming("");
      if (e instanceof ChatEngineError) {
        setError(e.message);
      } else if (e instanceof Error) {
        setError(e.message || "网络错误");
      } else {
        setError("网络错误");
      }
    } finally {
      setThinking(false);
    }
  }, [input, thinking]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--c-page-body-bg)" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #eee", fontSize: 15, fontWeight: 600, color: "#333" }}>
        陆知行
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {!ready && !error && <div style={{ fontSize: 13, color: "#999", padding: 8 }}>加载中...</div>}
        {error && <div style={{ fontSize: 13, color: "#e5484d", padding: 8 }}>{error}</div>}
        {messages.map((m) => (
          <div key={m.id} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 8 }}>
            <div style={{ maxWidth: "75%", padding: "10px 14px", borderRadius: 16, background: m.role === "user" ? "#4f8cff" : "#eee", color: m.role === "user" ? "#fff" : "#000", fontSize: 15, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {m.content}
            </div>
          </div>
        ))}
        {streaming && (
          <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 8 }}>
            <div style={{ maxWidth: "75%", padding: "10px 14px", borderRadius: 16, background: "#eee", color: "#000", fontSize: 15, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {streaming}
            </div>
          </div>
        )}
        {thinking && !streaming && <div style={{ fontSize: 13, color: "#999", padding: 8 }}>思考中...</div>}
        <div ref={endRef} />
      </div>
      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #eee" }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()}
          style={{ flex: 1, minHeight: 44, padding: 10, borderRadius: 12, border: "1px solid #ccc", fontSize: 15 }} placeholder="和陆知行说点什么..." />
        <button onClick={send} disabled={thinking || !ready}
          style={{ minHeight: 44, minWidth: 60, borderRadius: 12, border: "none", background: "#4f8cff", color: "#fff", fontSize: 15 }}>发送</button>
      </div>
    </div>
  );
}
