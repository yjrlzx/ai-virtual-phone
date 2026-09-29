"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { kvGet, kvSet } from "@/lib/kv-db";
import {
  getAndroidShell,
  loadHuaweiTriggerRules,
  saveHuaweiTriggerRules,
} from "@/lib/huawei-shell/storage";
import type { HuaweiShellBridge, HuaweiTriggerRule } from "@/lib/huawei-shell/types";
import { loadWakeAlarm, saveWakeAlarm, type WakeAlarmConfig } from "@/lib/lifeline-bridge";

/**
 * 华为现实桥 —— iOS 现实桥风格双页（main / history）+ Shizuku / 无障碍配置引导。
 *
 * 主色为 Y2K 冰蓝千禧复古（#6ab0f3 / #8ec5fc），内容卡片纯白平面，
 * 磨砂玻璃只用于底部悬浮 Dock 与圆形按钮。所有状态均来自 window.AndroidShell
 * 或 localStorage 缓存；壳未连接时优雅降级为本地缓存，不写死演示数据。
 */

/* ---------------- 视觉令牌（冰蓝 Y2K） ---------------- */

const ACCENT = "linear-gradient(135deg, #6ab0f3, #8ec5fc)";
const INK = "#2c4a6e";
const SUB = "#5a7a9e";
const FAINT = "#8aa8c8";
const GREEN = "#2fa46a";
const AMBER = "#e8a33d";
const RED = "#d9534f";

const CARD: CSSProperties = {
  background: "#fff",
  borderRadius: 18,
  padding: "14px 16px",
  boxShadow: "0 2px 10px rgba(90,130,180,.08)",
};

const TITLE: CSSProperties = {
  fontSize: 30,
  fontWeight: 800,
  letterSpacing: ".2px",
  color: INK,
  margin: 0,
};

const TILES: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 8,
};

const TILE: CSSProperties = {
  ...CARD,
  padding: "12px 11px 11px",
};

const TILE_LABEL: CSSProperties = {
  fontStyle: "normal",
  fontSize: 10.5,
  color: FAINT,
  display: "block",
};

const TILE_VALUE: CSSProperties = {
  display: "block",
  fontSize: 15,
  fontWeight: 800,
  marginTop: 6,
  color: INK,
  fontVariantNumeric: "tabular-nums",
};

const HINT: CSSProperties = {
  fontSize: 11.5,
  color: FAINT,
  lineHeight: 1.6,
  padding: "8px 4px 0",
};

const GROUP: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: ".8px",
  color: FAINT,
  textTransform: "uppercase",
  margin: "18px 4px 8px",
};

const PERM_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "11px 0",
  borderBottom: "1px solid rgba(150,190,230,.15)",
};

const PERM_NAME: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13.5,
  color: INK,
  fontWeight: 600,
};

const BADGE: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  padding: "4px 10px",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

const BADGE_OK: CSSProperties = { ...BADGE, background: "rgba(47,164,106,.13)", color: GREEN };
const BADGE_RED: CSSProperties = { ...BADGE, background: "rgba(217,83,79,.13)", color: RED };
const BADGE_AMBER: CSSProperties = { ...BADGE, background: "rgba(232,163,61,.16)", color: "#c8902e" };
const BADGE_GRAY: CSSProperties = { ...BADGE, background: "rgba(138,168,200,.14)", color: FAINT };

const BTN: CSSProperties = {
  border: "none",
  borderRadius: 999,
  padding: "7px 14px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  background: ACCENT,
  color: "#fff",
  whiteSpace: "nowrap",
};

const BTN_GHOST: CSSProperties = {
  ...BTN,
  background: "rgba(150,190,230,.15)",
  color: "#4a6a8e",
};

const BTN_RED: CSSProperties = {
  ...BTN,
  background: "rgba(217,83,79,.12)",
  color: RED,
};

const INPUT: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid rgba(150,190,230,.45)",
  borderRadius: 12,
  padding: "9px 12px",
  fontSize: 13,
  color: INK,
  background: "rgba(248,251,255,.9)",
  outline: "none",
};

const GUIDE_BOX: CSSProperties = {
  background: "rgba(106,176,243,.09)",
  borderRadius: 12,
  padding: 12,
  fontSize: 12,
  color: SUB,
  lineHeight: 1.75,
  marginTop: 10,
};

/* ---------------- 本地缓存 key ---------------- */

const NOTIF_CACHE_KEY = "huawei_bridge_notifications_cache_v1";
const SHORTCUT_KEY = "huawei_bridge_shortcut_history_v1";

type NotifEntry = { pkg?: string; title?: string; text?: string; ts?: number };
type ShortcutEntry = { id: string; label: string; ok: boolean; detail: string; at: number };

type PermStatus = {
  standard?: { location: boolean; microphone: boolean; storage: boolean };
  accessibility?: boolean;
  notificationListener?: boolean;
  debugger?: {
    shizukuInstalled?: boolean;
    shizukuRunning?: boolean;
    shizukuPermission?: boolean;
  };
  admin?: { overlay?: boolean };
};

type ShizukuState = "NOT_INSTALLED" | "NOT_RUNNING" | "NOT_GRANTED" | "GRANTED";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = kvGet(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value));
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--";
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/* ---------------- Dock 图标（细线 SVG） ---------------- */

function DockIcon({ kind }: { kind: "main" | "history" }) {
  const common = {
    width: 25,
    height: 25,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "history") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 11 12 4l8 7" />
      <path d="M6 10v10h12V10" />
    </svg>
  );
}

/* ---------------- 组件 ---------------- */

export function HuaweiBridgeWizard() {
  const [tab, setTab] = useState<"main" | "history">("main");
  const [histSec, setHistSec] = useState<"feed" | "commands">("feed");

  const [shellAvailable, setShellAvailable] = useState(false);
  const [status, setStatus] = useState<PermStatus | null>(null);
  const [feed, setFeed] = useState<NotifEntry[]>(() => loadJson<NotifEntry[]>(NOTIF_CACHE_KEY, []));
  const [commands, setCommands] = useState<ShortcutEntry[]>(() => loadJson<ShortcutEntry[]>(SHORTCUT_KEY, []));
  const [rules, setRules] = useState<HuaweiTriggerRule[]>(() => loadHuaweiTriggerRules());
  const [wake, setWake] = useState<WakeAlarmConfig>(() => loadWakeAlarm());

  /* 新建联动表单 */
  const [addOpen, setAddOpen] = useState(false);
  const [fName, setFName] = useState("");
  const [fKeyword, setFKeyword] = useState("");
  const [fTitle, setFTitle] = useState("");
  const [fContent, setFContent] = useState("");

  /* ---------- 快捷指令历史写入 ---------- */
  const pushCommand = (label: string, ok: boolean, detail: string) => {
    const entry: ShortcutEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      label,
      ok,
      detail: detail.slice(0, 120),
      at: Date.now(),
    };
    setCommands(prev => {
      const next = [entry, ...prev].slice(0, 50);
      saveJson(SHORTCUT_KEY, next);
      return next;
    });
  };

  /* 统一桥调用封装：每次真实壳调用都写入快捷指令历史 */
  const runAction = (label: string, fn: (shell: HuaweiShellBridge) => unknown) => {
    const shell = getAndroidShell();
    if (!shell) {
      pushCommand(label, false, "华为壳未连接");
      return;
    }
    try {
      const raw = fn(shell);
      const text = typeof raw === "string" && raw.trim() ? raw : "已执行";
      pushCommand(label, true, text);
    } catch (e) {
      pushCommand(label, false, e instanceof Error ? e.message : String(e));
    }
  };

  /* ---------- 权限状态轮询（每 5 秒） ---------- */
  const refreshPerms = () => {
    try {
      const shell = getAndroidShell();
      if (shell?.getPermissionStatus) {
        setStatus(JSON.parse(shell.getPermissionStatus("")) as PermStatus);
      }
    } catch {
      setStatus({
        standard: { location: false, microphone: false, storage: false },
        accessibility: false,
        notificationListener: false,
        admin: { overlay: false },
      });
    }
  };

  const refreshFeed = (limit: number): NotifEntry[] => {
    const shell = getAndroidShell();
    let list: NotifEntry[] = [];
    if (shell?.getNotifications) {
      try {
        const parsed = JSON.parse(shell.getNotifications(limit)) as unknown;
        if (Array.isArray(parsed)) {
          list = (parsed as Array<Record<string, unknown>>).map(n => ({
            pkg: typeof n.pkg === "string" ? n.pkg : undefined,
            title: typeof n.title === "string" ? n.title : undefined,
            text: typeof n.text === "string" ? n.text : undefined,
            ts: Number(n.ts) || 0,
          }));
        }
      } catch {
        list = loadJson<NotifEntry[]>(NOTIF_CACHE_KEY, []);
      }
      if (list.length) saveJson(NOTIF_CACHE_KEY, list);
    } else {
      list = loadJson<NotifEntry[]>(NOTIF_CACHE_KEY, []);
    }
    return list;
  };

  const tick = () => {
    setShellAvailable(getAndroidShell() !== null);
    refreshPerms();
    setFeed(refreshFeed(50));
  };

  useEffect(() => {
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 切到 history 页时立即刷新一次 */
  useEffect(() => {
    if (tab === "history") setFeed(refreshFeed(20));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* ---------- 新建联动规则 ---------- */
  const saveNewRule = () => {
    const name = fName.trim();
    if (!name) {
      pushCommand("新建联动", false, "规则名称不能为空");
      return;
    }
    const rule: HuaweiTriggerRule = {
      id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      enabled: true,
      trigger: "notification",
      notifyKeyword: fKeyword.trim() || undefined,
      action: "send_notification",
      title: fTitle.trim() || undefined,
      content: fContent.trim() || undefined,
    };
    const next = [rule, ...rules];
    setRules(next);
    saveHuaweiTriggerRules(next);
    pushCommand("新建联动", true, `已保存「${name}」`);
    setAddOpen(false);
    setFName("");
    setFKeyword("");
    setFTitle("");
    setFContent("");
  };

  /* ---------- Shizuku 状态机（严格短路，无版本数据时不显示待更新） ---------- */
  const dbg = status?.debugger;
  const installed = dbg?.shizukuInstalled === true;
  const running = dbg?.shizukuRunning === true;
  const permitted = dbg?.shizukuPermission === true;
  const shizukuState: ShizukuState = !installed
    ? "NOT_INSTALLED"
    : !running
      ? "NOT_RUNNING"
      : !permitted
        ? "NOT_GRANTED"
        : "GRANTED";

  const shizukuBadge =
    shizukuState === "GRANTED"
      ? { style: BADGE_OK, text: "已授权" }
      : shizukuState === "NOT_INSTALLED"
        ? { style: BADGE_RED, text: "未安装" }
        : shizukuState === "NOT_RUNNING"
          ? { style: BADGE_RED, text: "未运行" }
          : { style: BADGE_RED, text: "未授权" };

  const accOk = status?.accessibility === true;
  const todayCount = feed.filter(n => (n.ts ?? 0) >= startOfToday()).length;
  const enabledRules = rules.filter(r => r.enabled).length;

  /* ================= 渲染 ================= */

  return (
    <div style={{ padding: "8px 2px 4px" }}>
      {/* ============ MAIN 页 ============ */}
      {tab === "main" && (
        <>
          {/* 大标题 + 新建 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 4px 14px" }}>
            <h3 style={TITLE}>华为现实桥</h3>
            <button
              type="button"
              aria-label="新建联动规则"
              onClick={() => setAddOpen(v => !v)}
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: "none",
                background: ACCENT,
                color: "#fff",
                fontSize: 20,
                fontWeight: 700,
                lineHeight: 1,
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(106,176,243,.4)",
                flexShrink: 0,
              }}
            >
              ＋
            </button>
          </div>

          {/* 新建联动表单 */}
          {addOpen && (
            <div style={{ ...CARD, marginBottom: 14, display: "grid", gap: 10 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: INK }}>新建联动规则</div>
              <input style={INPUT} placeholder="规则名，如 支付到账提醒" value={fName} onChange={e => setFName(e.target.value)} />
              <input style={INPUT} placeholder="通知关键词（可空，如 到账）" value={fKeyword} onChange={e => setFKeyword(e.target.value)} />
              <input style={INPUT} placeholder="通知标题" value={fTitle} onChange={e => setFTitle(e.target.value)} />
              <input style={INPUT} placeholder="通知正文" value={fContent} onChange={e => setFContent(e.target.value)} />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" style={BTN_GHOST} onClick={() => setAddOpen(false)}>取消</button>
                <button type="button" style={BTN} onClick={saveNewRule}>保存</button>
              </div>
            </div>
          )}

          {/* 三个状态磁贴 */}
          <div style={TILES}>
            <div style={TILE}>
              <i style={TILE_LABEL}>云端存储</i>
              <b style={{ ...TILE_VALUE, color: shellAvailable ? GREEN : AMBER }}>
                {shellAvailable ? "已连接" : "未连接"}
              </b>
            </div>
            <div style={TILE}>
              <i style={TILE_LABEL}>今日收到</i>
              <b style={TILE_VALUE}>{todayCount} 条</b>
            </div>
            <div style={TILE}>
              <i style={TILE_LABEL}>联动启用</i>
              <b style={TILE_VALUE}>{enabledRules} / {rules.length}</b>
            </div>
          </div>

          <div style={HINT}>
            {shellAvailable
              ? `桥接已连接 · 无障碍${accOk ? "已开启" : "未开启"} · Shizuku${shizukuState === "GRANTED" ? "已授权" : "未就绪"}；权限每 5 秒自动刷新。`
              : "华为壳未连接，当前展示本地缓存数据；在真机 WebView 中打开后，通知与权限状态将实时同步。"}
          </div>

          {/* 起床学习闹钟 */}
          <div style={GROUP}>起床学习闹钟</div>
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: INK }}>
                每天到点响铃喊你起床学习
              </span>
              <button
                type="button"
                onClick={() => {
                  const next = { ...wake, enabled: !wake.enabled };
                  setWake(next);
                  saveWakeAlarm(next);
                }}
                style={{
                  width: 46,
                  height: 26,
                  borderRadius: 999,
                  border: "none",
                  background: wake.enabled ? GREEN : "rgba(150,190,230,.35)",
                  position: "relative",
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: "background .2s",
                }}
                aria-label="起床闹钟开关"
              >
                <span style={{
                  position: "absolute",
                  top: 3,
                  ...(wake.enabled ? { right: 3 } : { left: 3 }),
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,.2)",
                  transition: "left .2s, right .2s",
                }} />
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
              <input
                type="time"
                value={wake.time}
                onChange={e => {
                  const t = /^\d{2}:\d{2}$/.test(e.target.value) ? e.target.value : wake.time;
                  const next = { ...wake, time: t, lastFiredDate: "" };
                  setWake(next);
                  saveWakeAlarm(next);
                }}
                style={{ ...INPUT, width: 110 }}
              />
              <span style={{ fontSize: 12, color: SUB }}>
                {wake.enabled ? `已开启 · 每天 ${wake.time} 响铃` : "已关闭"}
                {!shellAvailable && wake.enabled ? "（壳未连接时仅网页通知）" : ""}
              </span>
            </div>
          </div>

          {/* 三级权限区：STANDARD */}
          <div style={GROUP}>STANDARD · 标准权限</div>
          <div style={CARD}>
            {([
              ["location", "位置"],
              ["microphone", "麦克风"],
              ["storage", "存储"],
            ] as const).map(([key, label]) => {
              const ok = status?.standard?.[key] === true;
              return (
                <div key={key} style={PERM_ROW}>
                  <span style={PERM_NAME}>{label}</span>
                  <span style={ok ? BADGE_OK : BADGE_GRAY}>{ok ? "已授权" : "未授权"}</span>
                  <button
                    type="button"
                    style={BTN}
                    onClick={() => runAction(`开启${label}设置`, s => s.openPermissionSettings?.(key) ?? "")}
                  >
                    开启
                  </button>
                </div>
              );
            })}
          </div>

          {/* ACCESSIBILITY */}
          <div style={GROUP}>ACCESSIBILITY · 无障碍权限</div>
          <div style={CARD}>
            <div style={{ ...PERM_ROW, borderBottom: "none" }}>
              <span style={PERM_NAME}>无障碍服务</span>
              <span style={accOk ? BADGE_OK : BADGE_RED}>{accOk ? "已开启" : "未开启"}</span>
              <button
                type="button"
                style={BTN}
                onClick={() => runAction("开启无障碍设置", s => s.openPermissionSettings?.("accessibility") ?? "")}
              >
                {accOk ? "已开" : "开启"}
              </button>
            </div>
            {!accOk && (
              <div style={GUIDE_BOX}>
                请在系统设置 → 无障碍列表里找到本应用服务并开启；开启后可模拟点击与滑动，是操控手机的核心能力。
              </div>
            )}
          </div>

          {/* DEBUGGER · Shizuku */}
          <div style={GROUP}>DEBUGGER · 调试权限</div>
          <div style={CARD}>
            <div style={{ ...PERM_ROW, borderBottom: "none" }}>
              <span style={PERM_NAME}>Shizuku 服务</span>
              <span style={shizukuBadge.style}>{shizukuBadge.text}</span>
            </div>

            {shizukuState === "NOT_INSTALLED" && (
              <div style={GUIDE_BOX}>
                <div style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>步骤 1：安装 Shizuku</div>
                Shizuku 是一个授予应用高级权限的工具，不需要 root。先安装 Shizuku 应用，安装完成后回到这里等待状态自动刷新。
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    style={BTN}
                    onClick={() => runAction("下载 Shizuku", s => s.openUrl?.("https://shizuku.rikka.app/zh-hans/") ?? "")}
                  >
                    下载 Shizuku
                  </button>
                  <button
                    type="button"
                    style={BTN_GHOST}
                    onClick={() => runAction("Shizuku 官方文档", s => s.openUrl?.("https://shizuku.rikka.app/zh-hans/guide/setup/") ?? "")}
                  >
                    官方文档
                  </button>
                </div>
              </div>
            )}

            {shizukuState === "NOT_RUNNING" && (
              <div style={GUIDE_BOX}>
                <div style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>步骤 2：启动 Shizuku 服务</div>
                已安装，现在需要启动服务，任选一种方式：
                <div style={{ marginTop: 6 }}>
                  <b>方法一（推荐）：</b>打开 Shizuku，选择「通过无线调试启动」，按提示开启开发者选项与无线调试，并允许获取无线调试权限。
                </div>
                <div style={{ marginTop: 6 }}>
                  <b>方法二（USB）：</b>手机连电脑后执行
                  <div style={{ fontFamily: "monospace", background: "rgba(255,255,255,.8)", borderRadius: 8, padding: "6px 8px", marginTop: 4, wordBreak: "break-all" }}>
                    adb shell sh /sdcard/Android/data/moe.shizuku.privileged.api/files/start.sh
                  </div>
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={BTN}
                    onClick={() => runAction("打开 Shizuku", s => s.openApp?.("moe.shizuku.privileged.api") ?? "")}
                  >
                    打开 Shizuku
                  </button>
                  <button
                    type="button"
                    style={BTN_GHOST}
                    onClick={() => runAction("Shizuku 官方文档", s => s.openUrl?.("https://shizuku.rikka.app/zh-hans/guide/setup/") ?? "")}
                  >
                    官方文档
                  </button>
                </div>
              </div>
            )}

            {shizukuState === "NOT_GRANTED" && (
              <div style={GUIDE_BOX}>
                <div style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>步骤 3：授予 Shizuku 权限</div>
                服务已启动，请在弹出的对话框中选择「允许」。若没有看到弹窗，请检查 Shizuku 是否在运行、重启服务后再试。
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    style={BTN}
                    onClick={() =>
                      runAction("去 Shizuku 授权", s =>
                        s.openPermissionSettings?.("shizuku") ?? s.openApp?.("moe.shizuku.privileged.api") ?? ""
                      )
                    }
                  >
                    去授权
                  </button>
                </div>
              </div>
            )}

            {shizukuState === "GRANTED" && (
              <div style={{ ...GUIDE_BOX, background: "rgba(47,164,106,.1)" }}>
                恭喜！Shizuku 已完全设置，现在可以使用 ADB 级别的调试能力。
              </div>
            )}
          </div>
        </>
      )}

      {/* ============ HISTORY 页 ============ */}
      {tab === "history" && (
        <>
          {/* 分段控件 */}
          <div
            style={{
              display: "flex",
              gap: 2,
              background: "rgba(150,190,230,.18)",
              borderRadius: 999,
              padding: 4,
              marginBottom: 14,
            }}
          >
            {([
              ["feed", "最近收到"],
              ["commands", "最近快捷指令"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setHistSec(key)}
                style={{
                  flex: 1,
                  padding: "10px 0",
                  fontSize: 13,
                  fontWeight: histSec === key ? 700 : 500,
                  color: histSec === key ? INK : SUB,
                  background: histSec === key ? "#fff" : "transparent",
                  border: "none",
                  borderRadius: 999,
                  cursor: "pointer",
                  boxShadow: histSec === key ? "0 1px 3px rgba(90,130,180,.12)" : "none",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {histSec === "feed" && (
            <>
              {feed.length === 0 && (
                <div style={{ textAlign: "center", color: FAINT, fontSize: 13, padding: "40px 0" }}>暂无记录</div>
              )}
              {feed.slice(0, 20).map((n, i) => (
                <div key={`${n.pkg ?? ""}-${n.ts ?? 0}-${i}`} style={{ ...CARD, marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                    <span
                      style={{
                        background: "rgba(106,176,243,.14)",
                        color: "#4a7ab8",
                        borderRadius: 999,
                        padding: "2.5px 9px",
                        fontSize: 10.5,
                        fontWeight: 800,
                      }}
                    >
                      {n.pkg || "通知"}
                    </span>
                    <span style={{ fontSize: 11, color: FAINT }}>{fmtTime(n.ts ?? 0)}</span>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: INK, wordBreak: "break-all" }}>
                    {n.title || ""}
                    {n.title && n.text ? " · " : ""}
                    {(n.text || "").slice(0, 120)}
                  </div>
                </div>
              ))}
            </>
          )}

          {histSec === "commands" && (
            <>
              {commands.length === 0 && (
                <div style={{ textAlign: "center", color: FAINT, fontSize: 13, padding: "40px 0" }}>暂无记录</div>
              )}
              {commands.map(c => (
                <div key={c.id} style={{ ...CARD, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 800,
                      color: "#fff",
                      background: c.ok ? GREEN : RED,
                      flexShrink: 0,
                    }}
                  >
                    {c.ok ? "✓" : "✗"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{c.label}</div>
                    <div style={{ fontSize: 11, color: FAINT, wordBreak: "break-all" }}>{c.detail}</div>
                  </div>
                  <span style={{ fontSize: 11, color: FAINT, whiteSpace: "nowrap" }}>{fmtTime(c.at)}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {/* ============ 底部悬浮玻璃 Dock ============ */}
      <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
        <div
          style={{
            position: "sticky",
            bottom: 10,
            display: "flex",
            gap: 14,
            alignItems: "center",
            background: "rgba(255,255,255,.72)",
            backdropFilter: "blur(16px) saturate(1.4)",
            WebkitBackdropFilter: "blur(16px) saturate(1.4)",
            border: "1px solid rgba(255,255,255,.8)",
            borderRadius: 999,
            padding: "8px 16px",
            boxShadow: "0 6px 20px rgba(90,130,180,.2)",
            zIndex: 5,
          }}
        >
          {([
            ["main", "main", "设置与联动"],
            ["history", "history", "接收历史"],
          ] as const).map(([key, kind, label]) => (
            <button
              key={key}
              type="button"
              aria-label={label}
              onClick={() => setTab(key)}
              style={{
                width: 52,
                height: 52,
                borderRadius: "50%",
                border: "none",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: tab === key ? "#fff" : "rgba(44,74,110,.75)",
                background: tab === key ? ACCENT : "transparent",
                boxShadow: tab === key ? "0 6px 16px rgba(106,176,243,.45)" : "none",
              }}
            >
              <DockIcon kind={kind} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
