"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { getAndroidShell, loadHuaweiTriggerRules } from "@/lib/huawei-shell/storage";
import { ACCENT, CARD, GREEN, AMBER, FAINT, INK, SUB, loadJson, startOfToday } from "./bridge/shared";
import { TabRules } from "./bridge/tab-rules";
import { TabShortcuts } from "./bridge/tab-shortcuts";
import { TabQueries } from "./bridge/tab-queries";
import { TabScreen } from "./bridge/tab-screen";

/**
 * 现实桥（安卓版）—— 还原 iOS 现实桥主界面：
 *   顶部标题 + 三个状态磁贴（云端存储 / 今日收到 / 联动启用）
 *   下方四个 Tab：自动联动 / 快捷动作 / 主动查询 / 屏幕速聊
 *
 * 能力用安卓方式落地：Shizuku（runShellCommand）+ 无障碍服务（dumpScreen/clickText）
 * + 通知监听（getNotifications）+ 截屏（captureScreen / MediaProjection）。
 * 状态均来自 window.AndroidShell 或 kv 缓存，壳未连接时优雅降级，不写死演示数据。
 */

type MainSec = "rules" | "shortcuts" | "queries" | "screen";

const SECTIONS: Array<{ key: MainSec; label: string }> = [
  { key: "rules", label: "自动联动" },
  { key: "shortcuts", label: "快捷动作" },
  { key: "queries", label: "主动查询" },
  { key: "screen", label: "屏幕速聊" },
];

type FeedEntry = { ts?: number };

type PermStatus = {
  accessibility?: boolean;
  debugger?: { shizukuInstalled?: boolean; shizukuRunning?: boolean; shizukuPermission?: boolean };
};

export function HuaweiBridgeWizard({ onNotice }: { onNotice?: (text: string) => void }) {
  const [sec, setSec] = useState<MainSec>("rules");
  const [shellAvailable, setShellAvailable] = useState(false);
  const [accOk, setAccOk] = useState(false);
  const [shizukuReady, setShizukuReady] = useState(false);
  const [todayCount, setTodayCount] = useState(0);
  const [ruleStats, setRuleStats] = useState({ enabled: 0, total: 0 });

  const tick = useCallback(() => {
    const shell = getAndroidShell();
    setShellAvailable(shell !== null);
    try {
      if (shell?.getPermissionStatus) {
        const s = JSON.parse(shell.getPermissionStatus("")) as PermStatus;
        setAccOk(s.accessibility === true);
        setShizukuReady(
          s.debugger?.shizukuInstalled === true &&
            s.debugger?.shizukuRunning === true &&
            s.debugger?.shizukuPermission === true,
        );
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

  return (
    <div style={{ padding: "8px 2px 4px" }}>
      {/* 标题 */}
      <h3 style={{ fontSize: 30, fontWeight: 800, letterSpacing: ".2px", color: INK, margin: "0 4px 14px" }}>
        现实桥
      </h3>

      {/* 三个状态磁贴 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {[
          { label: "云端存储", value: shellAvailable ? "已连接" : "未连接", color: shellAvailable ? GREEN : AMBER },
          { label: "今日收到", value: `${todayCount} 条`, color: INK },
          { label: "联动启用", value: `${ruleStats.enabled} / ${ruleStats.total}`, color: INK },
        ].map(t => (
          <div key={t.label} style={{ ...CARD, padding: "12px 11px 11px" }}>
            <i style={{ fontStyle: "normal", fontSize: 10.5, color: FAINT, display: "block" }}>{t.label}</i>
            <b style={{ display: "block", fontSize: 15, fontWeight: 800, marginTop: 6, color: t.color, fontVariantNumeric: "tabular-nums" }}>
              {t.value}
            </b>
          </div>
        ))}
      </div>

      <p style={{ fontSize: 11.5, color: FAINT, lineHeight: 1.6, padding: "8px 4px 0", margin: 0 }}>
        {shellAvailable
          ? `桥接已连接 · 无障碍${accOk ? "已开启" : "未开启"} · Shizuku${shizukuReady ? "已授权" : "未就绪"}；状态每 5 秒自动刷新。`
          : "安卓壳未连接，当前展示本地缓存；在真机 WebView 中打开后状态实时同步。"}
      </p>

      {/* 四个 Tab */}
      <div style={{ display: "flex", gap: 2, background: "rgba(150,190,230,.18)", borderRadius: 999, padding: 4, margin: "18px 0 4px" }}>
        {SECTIONS.map(s => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSec(s.key)}
            style={{
              flex: 1,
              padding: "9px 0",
              fontSize: 12.5,
              fontWeight: sec === s.key ? 700 : 500,
              color: sec === s.key ? INK : SUB,
              background: sec === s.key ? "#fff" : "transparent",
              border: "none",
              borderRadius: 999,
              cursor: "pointer",
              boxShadow: sec === s.key ? "0 1px 3px rgba(90,130,180,.12)" : "none",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 活动 Tab */}
      {sec === "rules" ? <TabRules onNotice={onNotice} /> : null}
      {sec === "shortcuts" ? <TabShortcuts onNotice={onNotice} /> : null}
      {sec === "queries" ? <TabQueries onNotice={onNotice} /> : null}
      {sec === "screen" ? <TabScreen onNotice={onNotice} /> : null}
    </div>
  );
}
