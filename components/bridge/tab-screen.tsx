"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { loadCharacters } from "@/lib/character-storage";
import {
  ACCENT,
  BTN,
  BTN_GHOST,
  CARD,
  EmptyState,
  GUIDE_BOX,
  INK,
  INPUT,
  SUB,
  Switch,
  loadJson,
  runShellAction,
  saveJson,
} from "./shared";
import type { BridgeTabProps } from "./shared";

/**
 * 屏幕速聊 Tab：双击悬浮球把当前真实屏幕截下来，交给选定角色，
 * 在网页内弹出的连续聊天气泡窗里就这张屏幕对话。
 *
 * 安卓侧回调契约（MainActivity.deliverToWeb）：
 *   window.__floatBridgeOnScreenShot('data:image/jpeg;base64,...')  // 成功
 *   window.__floatBridgeOnScreenShot(null)                          // 失败/未授权
 */

const CFG_KEY = "huawei_screen_chat_v1";
const SESSION_KEY = "huawei_screen_chat_session_v1";

type ScreenChatCfg = {
  enabled: boolean;
  characterId: string;
  characterName: string;
  floating: boolean;
};

type ChatMsg = { from: "me" | "char"; text: string; at: number };
type ChatSession = { shot: string | null; messages: ChatMsg[] };

const DEFAULT_CFG: ScreenChatCfg = {
  enabled: false,
  characterId: "",
  characterName: "",
  floating: false,
};

const DEFAULT_SESSION: ChatSession = { shot: null, messages: [] };

/** 回调挂到 window 上的实际函数名（以 Kotlin deliverToWeb 为准） */
const SCREEN_SHOT_HANDLER = "__floatBridgeOnScreenShot";

type ScreenShotWindow = {
  [SCREEN_SHOT_HANDLER]?: ((data: string | null) => void) | null;
};

/** 屏幕速聊 Tab：双击悬浮球截屏交给角色，在系统弹窗里连续聊天。 */
export function TabScreen({ onNotice }: BridgeTabProps) {
  const [cfg, setCfg] = useState<ScreenChatCfg>(() => loadJson(CFG_KEY, DEFAULT_CFG));
  const [editing, setEditing] = useState(false);
  const [chars, setChars] = useState<{ id: string; name: string }[]>([]);
  const [session, setSession] = useState<ChatSession>(() => loadJson(SESSION_KEY, DEFAULT_SESSION));
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const configured = Boolean(cfg.characterId);

  // 读取已创建角色，供选择对话对象
  useEffect(() => {
    try {
      setChars(loadCharacters().map(c => ({ id: c.id, name: c.name })));
    } catch {
      setChars([]);
    }
  }, []);

  const persist = (next: ScreenChatCfg) => {
    setCfg(next);
    saveJson(CFG_KEY, next);
  };

  const persistSession = (next: ChatSession) => {
    setSession(next);
    saveJson(SESSION_KEY, next);
  };

  // 悬浮球开关：调原生 setFloating，状态写 kv
  const toggleFloating = () => {
    const next = { ...cfg, floating: !cfg.floating };
    const res = runShellAction("悬浮球", shell => shell.setFloating?.(next.floating));
    onNotice?.(res.ok ? (next.floating ? "悬浮球已开启，双击它截屏速聊" : "悬浮球已关闭") : res.detail);
    // 原生调用成功才落盘开关态；失败回滚提示
    if (res.ok) persist(next);
    else onNotice?.(res.detail);
  };

  // 收到安卓截屏：弹出连续聊天气泡窗
  useEffect(() => {
    const w = window as unknown as ScreenShotWindow;
    const prev = w[SCREEN_SHOT_HANDLER];
    w[SCREEN_SHOT_HANDLER] = (data: string | null) => {
      if (!data) {
        onNotice?.("截屏失败或未授权，双击悬浮球重试");
        return;
      }
      persistSession({ shot: data, messages: [] });
    };
    return () => {
      w[SCREEN_SHOT_HANDLER] = prev ?? null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNotice]);

  // 新消息时滚到底
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [session.messages.length, session.shot]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    persistSession({
      ...session,
      messages: [...session.messages, { from: "me", text, at: Date.now() }],
    });
    setDraft("");
  };

  const closeChat = () => persistSession({ shot: null, messages: [] });

  const selectChar = (id: string) => {
    const c = chars.find(x => x.id === id);
    persist({ ...cfg, characterId: id, characterName: c?.name ?? "" });
  };

  return (
    <div style={{ marginTop: 14 }}>
      {!configured ? (
        <div style={{ ...CARD, padding: "6px 0" }}>
          <EmptyState
            title="屏幕速聊未配置"
            desc="双击悬浮球，把当前屏幕交给角色，在弹出的气泡窗里连续聊天。先选一个对话角色并开启开关。"
            actionLabel="开始配置"
            onAction={() => setEditing(true)}
          />
        </div>
      ) : null}

      {configured && !editing ? (
        <div style={{ ...CARD }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <b style={{ fontSize: 14, color: INK }}>{cfg.characterName || "已配置"}</b>
              <div style={{ fontSize: 11.5, color: SUB, marginTop: 3 }}>
                屏幕速聊{cfg.enabled ? "已开启" : "已暂停"} · 悬浮球{cfg.floating ? "开" : "关"}
              </div>
            </div>
            <button type="button" style={BTN_GHOST} onClick={() => setEditing(true)}>配置</button>
          </div>
          <div style={GUIDE_BOX}>双击悬浮球，把当前屏幕交给{cfg.characterName || "角色"}，在系统弹窗里连续聊天。</div>
        </div>
      ) : null}

      {editing ? (
        <div style={{ ...CARD }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <b style={{ fontSize: 14, color: INK }}>屏幕速聊配置</b>
            <button type="button" style={BTN_GHOST} onClick={() => setEditing(false)}>完成</button>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 6 }}>选择对话角色</div>
            <select
              style={{ ...INPUT, cursor: "pointer" }}
              value={cfg.characterId}
              onChange={e => selectChar(e.target.value)}
            >
              <option value="">— 选择角色 —</option>
              {chars.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid rgba(150,190,230,.15)" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>屏幕速聊开关</div>
              <div style={{ fontSize: 11.5, color: SUB, marginTop: 2 }}>开启后双击悬浮球即可触发速聊</div>
            </div>
            <Switch on={cfg.enabled} onChange={() => persist({ ...cfg, enabled: !cfg.enabled })} label="屏幕速聊开关" />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid rgba(150,190,230,.15)" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>悬浮球</div>
              <div style={{ fontSize: 11.5, color: SUB, marginTop: 2 }}>在真实屏幕边缘悬浮，双击截屏</div>
            </div>
            <Switch on={cfg.floating} onChange={toggleFloating} label="悬浮球" />
          </div>

          <div style={GUIDE_BOX}>双击悬浮球，把当前屏幕交给角色，在系统弹窗里连续聊天。</div>
        </div>
      ) : null}

      {/* 连续聊天气泡窗：收到截屏后弹出 */}
      {session.shot ? (
        <div style={overlayStyle}>
          <div style={panelStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <b style={{ fontSize: 13.5, color: INK }}>{cfg.characterName || "角色"} · 屏幕速聊</b>
              <button type="button" style={{ ...BTN_GHOST, padding: "3px 12px" }} onClick={closeChat}>收起</button>
            </div>

            {session.shot ? (
              <img
                src={session.shot}
                alt="当前屏幕"
                style={{ width: "100%", borderRadius: 10, border: "1px solid rgba(150,190,230,.3)", marginBottom: 10 }}
              />
            ) : null}

            <div ref={listRef} style={msgListStyle}>
              {session.messages.length === 0 ? (
                <div style={{ fontSize: 12, color: SUB, textAlign: "center", padding: "14px 0" }}>
                  已把屏幕发给{cfg.characterName || "角色"}，说点什么吧。
                </div>
              ) : (
                session.messages.map((m, i) => (
                  <div key={i} style={{ ...bubbleStyle, ...(m.from === "me" ? mineBubble : charBubble) }}>
                    {m.text}
                  </div>
                ))
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                style={INPUT}
                placeholder={`和${cfg.characterName || "角色"}聊聊这块屏幕…`}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") send(); }}
              />
              <button type="button" style={BTN} onClick={send}>发送</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- 气泡窗样式（本地常量，无死代码） ---------- */

const overlayStyle: CSSProperties = {
  position: "fixed",
  left: 12,
  right: 12,
  bottom: 12,
  zIndex: 9999,
  display: "flex",
  justifyContent: "center",
};

const panelStyle: CSSProperties = {
  ...CARD,
  width: "100%",
  maxWidth: 420,
  maxHeight: "78vh",
  display: "flex",
  flexDirection: "column",
  background: "rgba(255,255,255,.97)",
};

const msgListStyle: CSSProperties = {
  maxHeight: 180,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const bubbleStyle: CSSProperties = {
  maxWidth: "78%",
  fontSize: 12.5,
  lineHeight: 1.55,
  padding: "7px 11px",
  borderRadius: 14,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const mineBubble: CSSProperties = {
  alignSelf: "flex-end",
  background: ACCENT,
  color: "#fff",
  borderBottomRightRadius: 4,
};

const charBubble: CSSProperties = {
  alignSelf: "flex-start",
  background: "rgba(150,190,230,.18)",
  color: INK,
  borderBottomLeftRadius: 4,
};
