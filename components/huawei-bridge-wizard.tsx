"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { getAndroidShell, loadHuaweiTriggerRules, loadHuaweiCustomActions, loadHuaweiShellSettings, saveHuaweiShellSettings } from "@/lib/huawei-shell/storage";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatSessions } from "@/lib/chat-storage";
import { kvGet, kvSet } from "@/lib/kv-db";
import type { HuaweiShellSettings } from "@/lib/huawei-shell/storage";
import type { HuaweiPermissionStatus } from "@/lib/huawei-shell/types";
import {
  ACCENT,
  CARD,
  GREEN,
  AMBER,
  FAINT,
  INK,
  SUB,
  loadJson,
  startOfToday,
  CardRow,
  NavCard,
  SectionHeader,
} from "./bridge/shared";
import { TabRules } from "./bridge/tab-rules";
import { TabShortcuts } from "./bridge/tab-shortcuts";
import { TabQueries } from "./bridge/tab-queries";
import { TabScreen } from "./bridge/tab-screen";
import { TabVoice } from "./bridge/tab-voice";
import { TabControl } from "./bridge/tab-control";
import { TabMoney } from "./bridge/tab-money";
import { TabLock } from "./bridge/tab-lock";
import { TabPerms } from "./bridge/tab-permissions";
import { TabSystem } from "./bridge/tab-system";
import { TabApps } from "./bridge/tab-apps";
import { TabHistory } from "./bridge/tab-history";
import type { BridgeTabProps } from "./bridge/shared";

/**
 * 现实桥（安卓版）—— 两级分层导航：
 *   一级（底部 Tab 栏）：主页 / 自动化 / 操控 / 设置
 *   主页为仪表盘：标题 + 三个状态磁贴 + 大卡片入口列表；
 *   自动化 / 操控 / 设置 顶部各挂一个 ≤3 项的分段控制器。
 * 状态每 5 秒轮询一次壳；所有条目数实时读 kv，不写死演示数据。
 */

type RootTab = "home" | "auto" | "control" | "voice" | "settings";
type AutoSec = "rules" | "shortcuts" | "queries";
type ControlSec = "screen" | "gui" | "money" | "lock" | "system" | "apps";
type SettingsSec = "perms" | "history";

type FeedEntry = { ts?: number };

export function HuaweiBridgeWizard({ onNotice }: BridgeTabProps) {
  const [tab, setTab] = useState<RootTab>("home");
  const [autoSec, setAutoSec] = useState<AutoSec>("rules");
  const [controlSec, setControlSec] = useState<ControlSec>("screen");
  const [settingsSec, setSettingsSec] = useState<SettingsSec>("perms");

  const [shellAvailable, setShellAvailable] = useState(false);
  const [accOk, setAccOk] = useState(false);
  const [shizukuReady, setShizukuReady] = useState(false);
  const [todayCount, setTodayCount] = useState(0);
  const [ruleStats, setRuleStats] = useState({ enabled: 0, total: 0 });
  const [bridgeSettings, setBridgeSettings] = useState<HuaweiShellSettings>(() => loadHuaweiShellSettings());

  const tick = useCallback(() => {
    const shell = getAndroidShell();
    setShellAvailable(shell !== null);
    try {
      if (shell?.getPermissionStatus) {
        const s = JSON.parse(shell.getPermissionStatus("")) as HuaweiPermissionStatus;
        setAccOk(s.accessibility === true);
        setShizukuReady(
          s.debugger?.shizukuInstalled === true &&
            s.debugger?.shizukuRunning === true &&
            s.debugger?.shizukuPermission === true,
        );
      } else {
        setAccOk(false);
        setShizukuReady(false);
      }
    } catch {
      setAccOk(false);
      setShizukuReady(false);
    }
    let count = 0;
    if (shell?.getNotifications) {
      try {
        const arr = JSON.parse(shell.getNotifications(100)) as FeedEntry[];
        count = arr.filter(n => (n.ts ?? 0) >= startOfToday()).length;
      } catch {
        count = loadJson<FeedEntry[]>("huawei_bridge_notifications_cache_v1", []).filter(
          n => (n.ts ?? 0) >= startOfToday(),
        ).length;
      }
    }
    setTodayCount(count);
    const rules = loadHuaweiTriggerRules();
    setRuleStats({ enabled: rules.filter(r => r.enabled).length, total: rules.length });
  }, []);

  useEffect(() => {
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [tick]);

  /* 主页大卡片摘要：全部实时读 kv，随 tick 每 5 秒刷新一次 */
  const actionCount = loadHuaweiCustomActions().length;
  const queryItems = loadJson<unknown[]>("huawei_query_items_v1", []);
  const queryCount = Array.isArray(queryItems) ? queryItems.length : 0;
  const appsCache = loadJson<{ apps?: unknown[] }>("huawei_installed_apps_v1", { apps: [] });
  const appCount = Array.isArray(appsCache.apps) ? appsCache.apps.length : 0;
  const screenCfg = loadJson<{ characterName?: string }>("huawei_screen_chat_v1", {});
  const screenName = screenCfg.characterName?.trim() ? screenCfg.characterName.trim() : "未配置";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <div style={{ flex: "1 0 auto" }}>
        {tab === "home" ? (
          <HomeDashboard
            shellAvailable={shellAvailable}
            todayCount={todayCount}
            ruleStats={ruleStats}
            accOk={accOk}
            shizukuReady={shizukuReady}
            actionCount={actionCount}
            queryCount={queryCount}
            appCount={appCount}
            screenName={screenName}
            onOpen={(t, sub) => {
              setTab(t);
              if (t === "auto") setAutoSec(sub as AutoSec);
              else if (t === "control") setControlSec(sub as ControlSec);
              else if (t === "settings") setSettingsSec(sub as SettingsSec);
            }}          />
        ) : null}

        {tab === "auto" ? (
          <>
            <SectionHeader title="自动化" desc="通知 / 定时触发规则，以及一键执行的快捷动作与数据项。" />
            <Segmented
              value={autoSec}
              onChange={k => setAutoSec(k as AutoSec)}
              options={[
                { key: "rules", label: "联动规则" },
                { key: "shortcuts", label: "快捷指令" },
                { key: "queries", label: "数据项" },
              ]}
            />
            {autoSec === "rules" ? <TabRules onNotice={onNotice} /> : null}
            {autoSec === "shortcuts" ? <TabShortcuts onNotice={onNotice} /> : null}
            {autoSec === "queries" ? <TabQueries onNotice={onNotice} /> : null}
          </>
        ) : null}

        {tab === "control" ? (
          <>
            <SectionHeader title="操控" desc="悬浮球速聊、无障碍操控应用、记账与锁应用、系统控制与应用管理，全部经壳实时执行。" />
            <Segmented
              value={controlSec}
              onChange={k => setControlSec(k as ControlSec)}
              options={[
                { key: "screen", label: "速聊" },
                { key: "gui", label: "操控应用" },
                { key: "money", label: "记账" },
                { key: "lock", label: "锁应用" },
                { key: "system", label: "系统" },
                { key: "apps", label: "应用" },
              ]}
            />
            {controlSec === "screen" ? <TabScreen onNotice={onNotice} /> : null}
            {controlSec === "gui" ? <TabControl onNotice={onNotice} /> : null}
            {controlSec === "money" ? <TabMoney onNotice={onNotice} /> : null}
            {controlSec === "lock" ? <TabLock onNotice={onNotice} /> : null}
            {controlSec === "system" ? <TabSystem onNotice={onNotice} /> : null}
            {controlSec === "apps" ? <TabApps onNotice={onNotice} /> : null}
          </>
        ) : null}

        {tab === "voice" ? (
          <>
            <SectionHeader title="语音助手" desc="像小艺一样语音唤醒、连续对话与自动朗读，常驻后台保活。" />
            <TabVoice onNotice={onNotice} />
          </>
        ) : null}

        {tab === "settings" ? (
          <>
            <SectionHeader title="设置" desc="桥接总开关、五级权限与运行日志。" />
            <BridgeSettingsCard settings={bridgeSettings} onChange={next => {
              saveHuaweiShellSettings(next);
              setBridgeSettings(next);
            }} />
            <div style={{ height: 12 }} />
            <Segmented
              value={settingsSec}
              onChange={k => setSettingsSec(k as SettingsSec)}
              options={[
                { key: "perms", label: "权限管理" },
                { key: "history", label: "运行日志" },
              ]}
            />
            {settingsSec === "perms" ? <TabPerms onNotice={onNotice} /> : null}
            {settingsSec === "history" ? <TabHistory onNotice={onNotice} /> : null}
          </>
        ) : null}
      </div>

      <BottomBar tab={tab} onSelect={setTab} />
    </div>
  );
}

/* ---------------- 主页仪表盘 ---------------- */

function HomeDashboard({ shellAvailable, todayCount, ruleStats, accOk, shizukuReady, actionCount, queryCount, appCount, screenName, onOpen }: {
  shellAvailable: boolean;
  todayCount: number;
  ruleStats: { enabled: number; total: number };
  accOk: boolean;
  shizukuReady: boolean;
  actionCount: number;
  queryCount: number;
  appCount: number;
  screenName: string;
  onOpen: (t: "auto" | "control" | "voice" | "settings", sub: string) => void;
}) {
  const tiles = [
    { label: "云端存储", value: shellAvailable ? "已连接" : "未连接", color: shellAvailable ? GREEN : AMBER },
    { label: "今日收到", value: `${todayCount} 条`, color: INK },
    { label: "联动启用", value: `${ruleStats.enabled} / ${ruleStats.total}`, color: INK },
  ];

  const cards = [
    { icon: "⚡", title: "联动规则", summary: `${ruleStats.total} 条规则 · ${ruleStats.enabled} 条启用`, onTap: () => onOpen("auto", "rules") },
    { icon: "🔧", title: "快捷指令", summary: `${actionCount} 个动作`, onTap: () => onOpen("auto", "shortcuts") },
    { icon: "📊", title: "数据项", summary: `${queryCount} 个数据项`, onTap: () => onOpen("auto", "queries") },
    { icon: "💬", title: "屏幕速聊", summary: screenName, onTap: () => onOpen("control", "screen") },
    { icon: "🖐️", title: "操控应用", summary: "读屏树·点按钮·填字·手势", onTap: () => onOpen("control", "gui") },
    { icon: "💰", title: "记账", summary: "读取微信/支付宝支付", onTap: () => onOpen("control", "money") },
    { icon: "🔒", title: "锁应用", summary: "给应用加门禁锁", onTap: () => onOpen("control", "lock") },
    { icon: "🎛️", title: "系统控制", summary: "亮度/音量/网络", onTap: () => onOpen("control", "system") },
    { icon: "📱", title: "应用管理", summary: `${appCount} 个已装应用`, onTap: () => onOpen("control", "apps") },
    { icon: "🔐", title: "权限管理", summary: `无障碍${accOk ? "已开" : "未开"} · Shizuku${shizukuReady ? "就绪" : "未就绪"}`, onTap: () => onOpen("settings", "perms") },
    { icon: "🎙️", title: "语音助手", summary: "小艺式唤醒 · 连续对话", onTap: () => onOpen("voice", "") },
  ];

  return (
    <div>
      <h3 style={{ fontSize: 30, fontWeight: 800, letterSpacing: ".2px", color: INK, margin: "0 4px 14px" }}>
        现实桥
      </h3>

      {/* 三个状态磁贴 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        {tiles.map(t => (
          <div key={t.label} style={{ ...CARD, padding: 16 }}>
            <i style={{ fontStyle: "normal", fontSize: 10.5, color: FAINT, display: "block" }}>{t.label}</i>
            <b style={{ display: "block", fontSize: 15, fontWeight: 800, marginTop: 6, color: t.color, fontVariantNumeric: "tabular-nums" }}>
              {t.value}
            </b>
          </div>
        ))}
      </div>

      {/* 归电按钮 */}
      <button
        onClick={() => {
          try {
            const chars = loadCharacters();
            const companion = chars[0];
            const sessions = loadChatSessions();
            const session = sessions
              .filter((s) => !s.isGroup && companion && s.contactId === companion.id)
              .sort((a, b) => Date.parse(String(b.updatedAt ?? 0)) - Date.parse(String(a.updatedAt ?? 0)))[0];
            if (session) {
              window.dispatchEvent(new CustomEvent("ai-call-trigger", { detail: { sessionId: session.id, type: "voice", characterName: companion?.name } }));
            }
          } catch { /* ignore */ }
        }}
        style={{
          width: "100%", padding: "14px", marginTop: 12, borderRadius: 14, border: "none",
          background: "var(--c-icon-active, #4f8cff)", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
          minHeight: 48,
        }}
      >
        发起通话（归电）
      </button>

      {/* 情绪日记 */}
      <MoodDiaryCard />

      {/* 焦虑趋势（7天） */}
      <AnxietyTrendCard />

      {/* 大卡片入口列表 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
        {cards.map(c => (
          <NavCard key={c.title} icon={c.icon} title={c.title} summary={c.summary} onClick={c.onTap} />
        ))}
      </div>
    </div>
  );
}

function MoodQuickCard({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ ...CARD, marginTop: 12, padding: 14 }}>
      <b style={{ fontSize: 14, color: INK }}>{title}</b>
      <div style={{ fontSize: 11, color: FAINT, marginBottom: 8 }}>{desc}</div>
      {children}
    </div>
  );
}

function TodoList() {
  const [items, setItems] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("shared_todo") || "[]"); } catch { return []; } });
  const [text, setText] = useState("");
  const save = (v: string[]) => { setItems(v); localStorage.setItem("shared_todo", JSON.stringify(v)); };
  return (
    <div>
      {items.map((t, i) => (
        <div key={i} style={{ fontSize: 13, color: INK, padding: "4px 0", display: "flex", justifyContent: "space-between" }}>
          <span>{t}</span>
          <button onClick={() => save(items.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: FAINT, cursor: "pointer" }}>×</button>
        </div>
      ))}
      <input value={text} onChange={e => setText(e.target.value)} placeholder="加一项..." style={{ width: "100%", padding: 6, borderRadius: 6, border: "1px solid rgba(128,128,128,0.3)", marginTop: 6 }}
        onKeyDown={e => { if (e.key === "Enter" && text.trim()) { save([...items, text.trim()]); setText(""); } }} />
    </div>
  );
}

function TimeCapsule() {
  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  return (
    <div>
      <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ padding: 6, borderRadius: 6, border: "1px solid rgba(128,128,128,0.3)" }} />
      <input value={text} onChange={e => setText(e.target.value)} placeholder="写一段话..." style={{ width: "100%", padding: 6, borderRadius: 6, border: "1px solid rgba(128,128,128,0.3)", marginTop: 6 }} />
      <button onClick={() => { if (text && date) { localStorage.setItem(`capsule_${date}`, text); alert("已存"); } }} style={{ marginTop: 6, padding: "4px 12px", borderRadius: 6, border: "none", background: "#4f8cff", color: "#fff", cursor: "pointer" }}>封存</button>
    </div>
  );
}

function WaterTracker() {
  const today = new Date().toISOString().slice(0, 10);
  const [cups, setCups] = useState(() => { try { return parseInt(localStorage.getItem(`water_${today}`) || "0"); } catch { return 0; } });
  const add = () => { const v = cups + 1; setCups(v); localStorage.setItem(`water_${today}`, String(v)); };
  return <button onClick={add} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#4ecdc4", color: "#fff", cursor: "pointer" }}>今天已喝 {cups} 杯 +</button>;
}

function Pomodoro() {
  const [sec, setSec] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSec(s => { if (s <= 1) { setRunning(false); return 0; } return s - 1; }), 1000);
    return () => clearInterval(t);
  }, [running]);
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>{Math.floor(sec/60)}:{String(sec%60).padStart(2,"0")}</div>
      <button onClick={() => setRunning(!running)} style={{ marginTop: 6, padding: "4px 12px", borderRadius: 6, border: "none", background: running ? "#ff6b6b" : "#4f8cff", color: "#fff", cursor: "pointer" }}>{running ? "暂停" : "开始"}</button>
    </div>
  );
}

function PeriodTracker() {
  const [date, setDate] = useState(() => localStorage.getItem("period_last") || "");
  return <input type="date" value={date} onChange={e => { setDate(e.target.value); localStorage.setItem("period_last", e.target.value); }} style={{ padding: 6, borderRadius: 6, border: "1px solid rgba(128,128,128,0.3)" }} />;
}

const MOOD_TAGS = ["开心","平静","烦躁","难过","焦虑","累","委屈","想他","饿","困","生气","想家","迷茫","充实","轻松","紧张","害羞","得意","emo","还好"];

function MoodDiaryCard() {
  const today = new Date().toISOString().slice(0,10);
  const [, force] = useState(0);
  const current = (() => { try { return JSON.parse(kvGet(`mood_diary_${today}`) || '{"tags":[]}'); } catch { return { tags: [] }; } })();
  return (
    <div style={{ ...CARD, marginTop: 12, padding: 14 }}>
      <b style={{ fontSize: 14, color: INK }}>情绪日记</b>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {MOOD_TAGS.map(m => {
          const active = current.tags.includes(m);
          return (
            <button key={m} style={{ padding: "4px 10px", borderRadius: 999, fontSize: 12, border: active ? "1.5px solid #ff6b6b" : "1px solid rgba(128,128,128,0.3)", background: active ? "rgba(255,107,107,0.15)" : "transparent", cursor: "pointer" }}
              onClick={() => {
                const tags = active ? current.tags.filter((t: string) => t !== m) : [...current.tags, m];
                kvSet(`mood_diary_${today}`, JSON.stringify({ tags, ts: Date.now() }));
                force(n => n + 1);
              }}>{m}</button>
          );
        })}
      </div>
    </div>
  );
}

function AnxietyTrendCard() {
  const { loadCharacters } = require("@/lib/character-storage");
  const chars = loadCharacters();
  const c = chars[0];
  const today = c?.mood?.anxiety ?? 0;
  return (
    <div style={{ ...CARD, marginTop: 12, padding: 14 }}>
      <b style={{ fontSize: 14, color: INK }}>他的焦虑值：{today}</b>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 60, marginTop: 10 }}>
        {[0,1,2,3,4,5,6].map(i => {
          const v = i === 6 ? today : 0;
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ width: "100%", height: Math.max(4, v * 0.5), background: "#ff6b6b", borderRadius: 3 }} />
              <span style={{ fontSize: 9, color: FAINT }}>{i === 6 ? "今天" : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- 桥接总开关卡（设置页顶部） ---------------- */

function BridgeSettingsCard({ settings, onChange }: {
  settings: HuaweiShellSettings;
  onChange: (next: HuaweiShellSettings) => void;
}) {
  return (
    <div style={{ ...CARD, marginTop: 12 }}>
      <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 2 }}>桥接设置</b>
      <span style={{ fontSize: 11, color: FAINT }}>总开关关闭后，所有联动规则暂停检查；改动即时写入设置。</span>
      <div style={{ marginTop: 6, borderTop: "1px solid rgba(150,190,230,.15)" }}>
        <CardRow
          title="接收联动信号"
          desc="关闭后全局调度器不再触发任何联动规则"
          on={settings.bridgeEnabled}
          onToggle={() => onChange({ ...settings, bridgeEnabled: !settings.bridgeEnabled })}
        />
        <CardRow
          title="转发给自定义APP"
          desc="命中通知时广播 huawei.bridge.data 事件给订阅的自定义 APP"
          on={settings.bridgeBroadcast}
          onToggle={() => onChange({ ...settings, bridgeBroadcast: !settings.bridgeBroadcast })}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>信号检查频率</div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>调度器每隔多久扫一次通知与定时规则</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {[15, 30, 60, 120].map(sec => {
              const on = settings.ruleCheckIntervalSec === sec;
              return (
                <button key={sec} type="button"
                  onClick={() => onChange({ ...settings, ruleCheckIntervalSec: sec })}
                  style={{
                    border: "none", borderRadius: 999, padding: "6px 11px", fontSize: 11.5, fontWeight: 700,
                    cursor: "pointer", whiteSpace: "nowrap",
                    background: on ? ACCENT : "rgba(150,190,230,.15)",
                    color: on ? "#fff" : SUB,
                  }}>
                  {sec}秒
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 二级分段控制器 ---------------- */

function Segmented({ value, onChange, options }: {
  value: string;
  onChange: (key: string) => void;
  options: Array<{ key: string; label: string }>;
}) {
  return (
    <div style={{ display: "flex", gap: 4, background: "rgba(150,190,230,.18)", borderRadius: 999, padding: 4, margin: "0 0 12px" }}>
      {options.map(o => {
        const on = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            style={{
              flex: 1,
              padding: "9px 0",
              fontSize: 12.5,
              fontWeight: on ? 700 : 500,
              color: on ? INK : SUB,
              background: on ? "#fff" : "transparent",
              border: "none",
              borderRadius: 999,
              cursor: "pointer",
              boxShadow: on ? "0 1px 3px rgba(90,130,180,.12)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- 底部一级 Tab 栏 ---------------- */

const BOTTOM_TABS: Array<{ key: RootTab; label: string; icon: string }> = [
  { key: "home", label: "主页", icon: "⌂" },
  { key: "auto", label: "自动化", icon: "⚡" },
  { key: "control", label: "操控", icon: "🎛" },
  { key: "voice", label: "语音", icon: "🎙" },
  { key: "settings", label: "设置", icon: "⚙" },
];

function BottomBar({ tab, onSelect }: { tab: RootTab; onSelect: (t: RootTab) => void }) {
  const barStyle: CSSProperties = {
    position: "sticky",
    bottom: 0,
    zIndex: 20,
    display: "flex",
    background: "rgba(255,255,255,.85)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    borderTop: "1px solid rgba(150,190,230,.35)",
    borderRadius: 16,
    marginTop: 14,
    padding: "6px 6px calc(6px + env(safe-area-inset-bottom, 0px))",
  };
  return (
    <nav style={barStyle}>
      {BOTTOM_TABS.map(it => {
        const active = tab === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              padding: "6px 0",
              color: active ? INK : SUB,
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>{it.icon}</span>
            <span style={{ fontSize: 11, fontWeight: active ? 800 : 500 }}>{it.label}</span>
            <span style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: active ? ACCENT : "transparent",
            }} />
          </button>
        );
      })}
    </nav>
  );
}
