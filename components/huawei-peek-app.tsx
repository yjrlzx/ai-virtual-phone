import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  getAndroidShell,
  isHuaweiShellAvailable,
  invokeShellJson,
  fetchHuaweiCurrentWeather,
  getHuaweiLedgerSummary,
  syncHuaweiLedgerFromShell,
  readLockedPackagesFromShell,
  loadHuaweiHealthSnapshot,
} from "@/lib/huawei-shell/storage";
import type { HuaweiHealthSnapshot } from "@/lib/huawei-shell/types";

/**
 * 掌心窗 —— float 桌面独立 App。
 *
 * 把掌心窗的「今天 / 陪伴 / 守护」做成 float 桌面上一个正式入口，
 * 数据全部从华为壳原生桥实时读取（电量 / 当前应用 / 位置 / 天气 /
 * 通知 / 门禁 / 账本 / 健康），未连接时给出引导。
 *
 * 只做增量：不动 float 壳、素材集市、内置 AI 对话与 char 主流程。
 */

const WINDOW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  borderRadius: 16,
  overflow: "hidden",
  border: "1px solid rgba(150,190,230,.5)",
  boxShadow: "0 10px 32px rgba(90,130,180,.25)",
  background: "linear-gradient(180deg,#f3f7ff,#eef5ff)",
};

const TITLEBAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  background: "linear-gradient(180deg, rgba(255,255,255,.9), rgba(214,229,248,.6))",
  borderBottom: "1px solid rgba(140,180,220,.4)",
  color: "#2c4a6e",
  fontWeight: 600,
  fontSize: 15,
};

const CARD: CSSProperties = {
  background: "rgba(255,255,255,.72)",
  border: "1px solid rgba(150,190,230,.35)",
  borderRadius: 12,
  padding: "12px 14px",
  marginBottom: 10,
};

const TAB_STYLE: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "6px 10px",
};

const TAB_BTN: CSSProperties = {
  flex: 1,
  border: "1px solid rgba(140,180,220,.5)",
  background: "rgba(255,255,255,.7)",
  color: "#3a5a80",
  borderRadius: 10,
  padding: "8px 0",
  cursor: "pointer",
  fontWeight: 600,
};

const TAB_BTN_ON: CSSProperties = {
  ...TAB_BTN,
  background: "#dbe9ff",
  color: "#1f3f6b",
};

function row(label: string, value: string) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0", fontSize: 13 }}>
      <span style={{ color: "#6a83a0" }}>{label}</span>
      <span style={{ color: "#2c4a6e", fontWeight: 500, textAlign: "right" }}>{value}</span>
    </div>
  );
}

type StatusData = {
  battery?: number;
  volume?: number;
  network?: boolean;
  accessibility?: boolean;
  floating?: boolean;
  lockedApps?: number;
};

export function HuaweiPeekApp({ onClose }: { onClose: () => void; onNotice?: (t: string) => void }) {
  const [tab, setTab] = useState<"today" | "companion" | "guard">("today");
  const [shellAvailable, setShellAvailable] = useState(false);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [currentApp, setCurrentApp] = useState("");
  const [location, setLocation] = useState("");
  const [weather, setWeather] = useState("");
  const [locked, setLocked] = useState<string[]>([]);
  const [ledger, setLedger] = useState(() => getHuaweiLedgerSummary());
  const [health, setHealth] = useState<HuaweiHealthSnapshot | null>(() => loadHuaweiHealthSnapshot());

  const refresh = useCallback(() => {
    const avail = isHuaweiShellAvailable();
    setShellAvailable(avail);
    if (!avail) return;
    const st = invokeShellJson<Record<string, unknown>>(s => (s.getStatus ? s.getStatus() : null));
    if (st.ok) setStatus(st.data as StatusData);
    const app = invokeShellJson<Record<string, unknown>>(s => (s.getCurrentApp ? s.getCurrentApp() : null));
    if (app.ok && typeof app.data.currentApp === "string") setCurrentApp(app.data.currentApp);
    const loc = invokeShellJson<Record<string, unknown>>(s => (s.getLocation ? s.getLocation() : null));
    if (loc.ok && typeof loc.data.lat === "number" && typeof loc.data.lng === "number") {
      setLocation(`纬度 ${Number(loc.data.lat).toFixed(4)}，经度 ${Number(loc.data.lng).toFixed(4)}`);
    }
    setLocked(readLockedPackagesFromShell());
    syncHuaweiLedgerFromShell(20);
    setLedger(getHuaweiLedgerSummary());
  }, []);

  useEffect(() => {
    refresh();
    void fetchHuaweiCurrentWeather().then(r => { if (r.ok) setWeather(r.data ?? ""); });
    const timer = setInterval(() => {
      refresh();
      void fetchHuaweiCurrentWeather().then(r => { if (r.ok) setWeather(r.data ?? ""); });
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  const guardPlanName = "陪伴者";

  return (
    <div style={WINDOW_STYLE}>
      <div style={TITLEBAR}>
        <span style={{ fontSize: 18 }}>🪟</span>
        <span>掌心窗</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onClose} aria-label="关闭" style={{
          border: "none", background: "rgba(140,175,215,.25)", color: "#2c4a6e",
          borderRadius: 8, width: 26, height: 26, cursor: "pointer", fontSize: 14, lineHeight: 1,
        }}>✕</button>
      </div>

      <div style={{ padding: 10 }}>
        {!shellAvailable && (
          <div style={{ ...CARD, background: "#fff4e6", borderColor: "rgba(230,160,80,.5)" }}>
            <div style={{ fontWeight: 600, color: "#9a6a2a" }}>未连接真机</div>
            <div style={{ fontSize: 12, color: "#8a6a40", marginTop: 4 }}>
              请用华为壳 App 打开本站，检测到 window.AndroidShell 后自动开始读取手机状态。
            </div>
          </div>
        )}

        {/* 顶部状态卡 */}
        <div style={CARD}>
          <div style={{ fontWeight: 600, color: "#2c4a6e", marginBottom: 6 }}>手机状态</div>
          {row("电量", status?.battery != null ? `${status.battery}%` : "—")}
          {row("当前应用", currentApp || "—")}
          {row("位置", location || "—")}
          {row("天气", weather || "—")}
          {row("网络", status?.network ? "已连接" : "—")}
          {row("门禁锁", status?.lockedApps != null ? `${status.lockedApps} 个` : "—")}
        </div>

        <div style={TAB_STYLE}>
          {([["today", "今天"], ["companion", "陪伴"], ["guard", "守护"]] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              style={tab === id ? TAB_BTN_ON : TAB_BTN}>{label}</button>
          ))}
        </div>

        {tab === "today" && (
          <>
            <div style={CARD}>
              <div style={{ fontWeight: 600, color: "#2c4a6e", marginBottom: 6 }}>此刻状态</div>
              {row("无障碍", status?.accessibility ? "已开启" : "未开启")}
              {row("悬浮球", status?.floating ? "已开启" : "未开启")}
              {row("账本", `共 ${ledger.total} 笔`)}
              {row("微信 / 支付宝", `${ledger.wechat} / ${ledger.alipay}`)}
            </div>
            <div style={CARD}>
              <div style={{ fontWeight: 600, color: "#2c4a6e", marginBottom: 6 }}>窗语</div>
              <div style={{ fontSize: 15, color: "#3a5a80", lineHeight: 1.6 }}>
                把今天，轻轻收进窗里。窗外安安静静，状态都在轻轻更新。
              </div>
            </div>
          </>
        )}

        {tab === "companion" && (
          <div style={CARD}>
            <div style={{ fontWeight: 600, color: "#2c4a6e", marginBottom: 6 }}>陪伴</div>
            {row("陪伴者", guardPlanName)}
            {row("最近一句话", "把今天，轻轻收进窗里。")}
            {row("下个纪念日", "元旦")}
            {row("陪伴天数", "第 1 天")}
          </div>
        )}

        {tab === "guard" && (
          <>
            <div style={CARD}>
              <div style={{ fontWeight: 600, color: "#2c4a6e", marginBottom: 6 }}>应用门禁</div>
              {locked.length === 0
                ? <div style={{ fontSize: 13, color: "#6a83a0" }}>暂无锁定的 App，去华为现实桥维护列表。</div>
                : locked.map(pkg => <div key={pkg} style={{ fontSize: 13, color: "#3a5a80", padding: "2px 0" }}>{pkg}</div>)}
            </div>
            <div style={CARD}>
              <div style={{ fontWeight: 600, color: "#2c4a6e", marginBottom: 6 }}>健康快照</div>
              {health ? (
                <>
                  {row("今日步数", health.stepsToday != null ? `${health.stepsToday}` : "—")}
                  {row("心率", health.latestHeartRate != null ? `${health.latestHeartRate}` : "—")}
                  {row("睡眠", health.sleepMinutes != null ? `${health.sleepMinutes} 分钟` : "—")}
                </>
              ) : <div style={{ fontSize: 13, color: "#6a83a0" }}>暂无健康数据，去华为现实桥刷新。</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
