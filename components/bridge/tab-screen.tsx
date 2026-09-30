"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { loadCharacters } from "@/lib/character-storage";
import { getAndroidShell } from "@/lib/huawei-shell/storage";
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

  // 悬浮球速聊入口卡：壳连接态 + 悬浮窗权限（getStatus().floating）+ 球是否在跑（乐观本地态）
  const [shellConnected, setShellConnected] = useState(false);
  const [overlayPerm, setOverlayPerm] = useState<boolean | null>(null);
  const [ballOn, setBallOn] = useState<boolean>(cfg.floating);

  const configured = Boolean(cfg.characterId);

  // 读取已创建角色，供选择对话对象
  useEffect(() => {
    try {
      setChars(loadCharacters().map(c => ({ id: c.id, name: c.name })));
    } catch {
      setChars([]);
    }
  }, []);

  // 每 5 秒拉一次壳状态：是否连接 + 悬浮窗权限（桥不直接查球是否在跑，球态靠乐观更新）
  useEffect(() => {
    const refresh = () => {
      const shell = getAndroidShell();
      setShellConnected(shell !== null);
      if (shell?.getStatus) {
        try {
          const st = JSON.parse(shell.getStatus()) as { floating?: boolean };
          setOverlayPerm(st.floating === true);
        } catch {
          setOverlayPerm(null);
        }
      } else {
        setOverlayPerm(null);
      }
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
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
    if (res.ok) {
      persist(next);
      setBallOn(next.floating);
    } else onNotice?.(res.detail);
  };

  // 悬浮球速聊卡开关：未授悬浮窗权限时跳授权页，否则乐观开/关并 5 秒后随 tick 复核
  const toggleBallCard = () => {
    if (!shellConnected) {
      onNotice?.("需在安卓壳 WebView 内使用");
      return;
    }
    if (overlayPerm === false) {
      const res = runShellAction("悬浮窗权限", s => s.openPermissionSettings?.("overlay"));
      onNotice?.(res.ok ? "请在系统设置里允许本应用悬浮窗" : res.detail);
      return;
    }
    const next = !ballOn;
    setBallOn(next); // 乐观更新；桥不直接查球态，靠下次 tick / 重启校对
    const res = runShellAction("悬浮球", s => s.setFloating?.(next));
    if (res.ok) {
      onNotice?.(next ? "悬浮球已开启，双击屏幕边缘的球截屏速聊" : "悬浮球已关闭");
      persist({ ...cfg, floating: next });
    } else {
      setBallOn(!next);
      onNotice?.(res.detail);
    }
  };

  // 一键打开悬浮聊天小窗
  const openQuickChat = () => {
    if (!shellConnected) {
      onNotice?.("需在安卓壳 WebView 内使用");
      return;
    }
    const res = runShellAction("打开快速聊天", s => s.openFloatingChat?.());
    onNotice?.(res.ok ? "已拉起悬浮聊天小窗" : res.detail);
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
      {/* 悬浮球速聊入口卡：开关悬浮球 + 一键打开快速聊天 + 华为 P60 权限引导 */}
      <div style={{ ...CARD, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <b style={{ fontSize: 14, color: INK }}>悬浮球速聊</b>
            <div style={{ fontSize: 11.5, color: SUB, marginTop: 3 }}>
              {shellConnected
                ? overlayPerm === false
                  ? "缺悬浮窗权限，先授权再开球"
                  : ballOn ? "悬浮球已在屏幕边缘运行" : "悬浮球已关闭"
                : "需在安卓壳 WebView 内使用"}
            </div>
          </div>
          <Switch on={ballOn && overlayPerm !== false} onChange={toggleBallCard} label="悬浮球" />
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button type="button" style={{ ...BTN, opacity: shellConnected ? 1 : .5 }} disabled={!shellConnected} onClick={openQuickChat}>
            打开快速聊天
          </button>
          {overlayPerm === false ? (
            <button type="button" style={BTN_GHOST} disabled={!shellConnected}
              onClick={() => {
                const res = runShellAction("悬浮窗权限", s => s.openPermissionSettings?.("overlay"));
                onNotice?.(res.ok ? "请在系统设置里允许本应用悬浮窗" : res.detail);
              }}>
              去开悬浮窗权限
            </button>
          ) : null}
        </div>

        {overlayPerm === false ? (
          <div style={GUIDE_BOX}>
            <b style={{ color: INK }}>华为 P60 / HarmonyOS 3.1 授权路径：</b>
            <div style={{ marginTop: 4 }}>设置 → 应用和服务 → 权限管理 → 悬浮窗 → 找到本应用 → 允许；</div>
            <div style={{ marginTop: 4 }}>或：手机管家 → 应用启动管理 → 找到本应用，关闭「自动管理」，手动允许「自启动」和「关联启动」。</div>
            <div style={{ marginTop: 4 }}>
              电池别杀后台：设置 → 电池 → 应用启动管理 → 本应用选「不限制」
              （或点下方按钮直接请求忽略电池优化）。
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button type="button" style={BTN_GHOST}
                onClick={() => {
                  const res = runShellAction("电池优化", s => s.requestIgnoreBatteryOptimization?.());
                  onNotice?.(res.ok ? "已弹出电池优化白名单请求" : res.detail);
                }}>
                请求电池不限制
              </button>
              <button type="button" style={BTN_GHOST}
                onClick={() => {
                  const res = runShellAction("应用详情", s => s.openAppSettings?.());
                  onNotice?.(res.ok ? "已打开本应用系统详情页" : res.detail);
                }}>
                应用详情页
              </button>
            </div>
          </div>
        ) : null}

        {!shellConnected ? (
          <div style={{ ...GUIDE_BOX, marginTop: 10 }}>
            需在安卓壳 WebView 内使用：悬浮球与快速聊天小窗由安卓壳提供，浏览器里按钮已禁用。
          </div>
        ) : null}
      </div>

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
