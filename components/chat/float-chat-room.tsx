"use client";

import { useState, useEffect, useRef } from "react";

// 精简悬浮窗聊天：复用主聊天 store，固定和陆知行聊
export function FloatChatRoom() {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 从主聊天 store 加载陆知行历史
    try {
      const { loadMessagesForCharacter } = require("@/lib/chat-engine");
      loadMessagesForCharacter("char_luzhixing_seed").then(setMessages);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || thinking) return;
    setInput("");
    setThinking(true);
    try {
      const { sendMessage } = require("@/lib/chat-engine");
      const reply = await sendMessage("char_luzhixing_seed", text);
      setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: reply }]);
    } catch {
      setMessages((m) => [...m, { role: "user", content: text }]);
    } finally {
      setThinking(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--c-page-body-bg)" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {messages.map((m: any, i: number) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 8 }}>
            <div style={{ maxWidth: "75%", padding: "10px 14px", borderRadius: 16, background: m.role === "user" ? "#4f8cff" : "#eee", color: m.role === "user" ? "#fff" : "#000", fontSize: 15 }}>
              {m.content}
            </div>
          </div>
        ))}
        {thinking && <div style={{ fontSize: 13, color: "#999", padding: 8 }}>思考中...</div>}
        <div ref={endRef} />
      </div>
      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #eee" }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()}
          style={{ flex: 1, minHeight: 44, padding: 10, borderRadius: 12, border: "1px solid #ccc", fontSize: 15 }} placeholder="和陆知行说点什么..." />
        <button onClick={send} disabled={thinking}
          style={{ minHeight: 44, minWidth: 60, borderRadius: 12, border: "none", background: "#4f8cff", color: "#fff", fontSize: 15 }}>发送</button>
      </div>
    </div>
  );
}
