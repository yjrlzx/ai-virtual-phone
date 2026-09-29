import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  getAndroidShell,
  isHuaweiShellAvailable,
  invokeShellJson,
  fetchHuaweiCurrentWeather,
  pushLockedPackagesToShell,
  readLockedPackagesFromShell,
  loadHuaweiFootprint,
  loadHuaweiTriggerRules,
  loadHuaweiShellSettings,
} from "@/lib/huawei-shell/storage";
import type { HuaweiFootprintEntry, HuaweiTriggerRule } from "@/lib/huawei-shell/types";
import { loadCharacters } from "@/lib/character-storage";
import { loadDiaryEntries } from "@/lib/diary-entry-storage";
import type { DiaryEntry } from "@/lib/diary-entry-types";
import {
  loadMenstrualConfig,
  loadMenstrualRecords,
  getNextPredictedPeriodStart,
} from "@/lib/menstrual-storage";
import { formatIsoDate } from "@/lib/calendar-utils";
import {
  readWindowLine,
  nextWindowLine,
  readTodayFocusMinutes,
  addTodayFocusMinutes,
  readCompanionMeta,
  companionDayCount,
  nextAnniversary,
  readPeekCalendarDots,
} from "@/lib/huawei-shell/peek-store";

/**
 * 掌心窗 —— float 桌面独立 App，严格还原安卓 linjian-peek 三页杂志式卡片：
 *   今天 buildTodayMagazine / 陪伴 buildCompanionMagazine / 守护 buildGuardMagazine
 * Y2K 冰蓝磨砂玻璃风。数据全部来自 window.AndroidShell 或既有 kv 本地存储，无假按钮。
 */

const ICE = "#7ec8ff";
const ICE_DEEP = "#4aa8ef";
const ICE_LIGHT = "#bfe4ff";
const INK = "#2c4a6e";
const INK_SOFT = "#5a7ea6";
const INK_FAINT = "#8aa8c8";

const FOCUS_GOAL_MIN = 120; // 今日专注目标（用于细进度条比例）

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const STATUS_LABEL: Record<HuaweiFootprintEntry["status"], string> = {
  home: "在家",
  place: "在常用地点",
  away: "在外",
  moving: "移动中",
};

/* ---------- 样式原语（磨砂玻璃） ---------- */

const WINDOW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  borderRadius: 18,
  overflow: "hidden",
  border: "1px solid rgba(126,200,255,.5)",
  boxShadow: "0 16px 44px rgba(90,150,210,.32)",
  background: "linear-gradient(180deg,#e9f6ff 0%,#d5edff 60%,#cfe9ff 100%)",
  color: INK,
};

const TITLEBAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  fontSize: 15,
  fontWeight: 800,
  color: INK,
  background: "rgba(255,255,255,.55)",
  backdropFilter: "blur(12px)",
  borderBottom: "1px solid rgba(126,200,255,.35)",
};

const TABBAR: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "10px 12px 6px",
};

const TAB_BTN: CSSProperties = {
  flex: 1,
  border: "1px solid rgba(126,200,255,.4)",
  borderRadius: 999,
  padding: "7px 0",
  cursor: "pointer",
  fontWeight: 700,
  fontSize: 13,
  color: INK_SOFT,
  background: "rgba(255,255,255,.6)",
  backdropFilter: "blur(8px)",
};

const TAB_BTN_ON: CSSProperties = {
  ...TAB_BTN,
  background: `linear-gradient(135deg,${ICE},${ICE_DEEP})`,
  color: "#ffffff",
  border: "none",
  boxShadow: "0 5px 14px rgba(74,168,239,.45)",
};

const CARD: CSSProperties = {
  background: "rgba(255,255,255,.68)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(126,200,255,.32)",
  borderRadius: 18,
  padding: "14px 16px",
  marginBottom: 12,
  boxShadow: "0 6px 18px rgba(120,180,230,.14)",
};

const HERO: CSSProperties = {
  ...CARD,
  background: "linear-gradient(135deg,#d6efff 0%,#eaf8ff 60%,#ffffff 100%)",
  borderRadius: 20,
  padding: "18px 18px 16px",
};

const LABEL: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2,
  color: INK_FAINT,
  fontWeight: 700,
};

const GROUP_TITLE: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2.5,
  color: INK_FAINT,
  fontWeight: 700,
  margin: "4px 4px 8px",
};

const ACTION_BTN: CSSProperties = {
  border: "none",
  borderRadius: 999,
  padding: "7px 14px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  color: "#fff",
  background: `linear-gradient(135deg,${ICE},${ICE_DEEP})`,
  boxShadow: "0 4px 10px rgba(74,168,239,.4)",
};

const ACTION_BTN_GHOST: CSSProperties = {
  ...ACTION_BTN,
  background: "rgba(255,255,255,.85)",
  color: INK,
  border: `1px solid rgba(126,200,255,.55)`,
  boxShadow: "none",
};

/* ---------- 小部件 ---------- */

type StatusData = Record<string, unknown>;

function statusNum(s: StatusData | null, key: string): number | null {
  const v = Number(s?.[key]);
  return Number.isFinite(v) ? v : null;
}
function statusBool(s: StatusData | null, key: string): boolean | null {
  const v = s?.[key];
  return typeof v === "boolean" ? v : null;
}

function BatteryIcon({ level }: { level: number | null }) {
  const pct = level == null ? 0 : Math.max(0, Math.min(100, level));
  const color = pct >= 50 ? "#5fc98a" : pct >= 20 ? "#f2b866" : "#ff8a8a";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{
        position: "relative", width: 26, height: 12, borderRadius: 3,
        border: `1.5px solid ${color}`, display: "inline-block",
      }}>
        <span style={{
          position: "absolute", inset: 1, width: `${pct}%`, borderRadius: 2,
          background: color, transition: "width .3s",
        }} />
        <span style={{
          position: "absolute", right: -4, top: 3, width: 2, height: 6,
          background: color, borderRadius: 1,
        }} />
      </span>
    </span>
  );
}

function FootprintTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 下一次触发的具体时刻（严格按星期匹配）；不可解析返回 null。 */
function nextTriggerDate(rule: HuaweiTriggerRule): Date | null {
  if (!rule.time) return null;
  const [h, m] = rule.time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const days = rule.days && rule.days.length > 0 ? rule.days : WEEKDAYS;
  const now = new Date();
  for (let offset = 0; offset <= 7; offset++) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m, 0, 0);
    if (cand.getTime() <= now.getTime()) continue;
    if (!days.includes(WEEKDAYS[cand.getDay()])) continue;
    return cand;
  }
  return null;
}

function triggerLabel(date: Date, time: string): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((that.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  return `${diff} 天后 ${time}`;
}

/* ---------- 主组件 ---------- */

export function HuaweiPeekApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (t: string) => void }) {
  const [tab, setTab] = useState<"today" | "companion" | "guard">("today");
  const [shellAvailable, setShellAvailable] = useState(false);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [currentApp, setCurrentApp] = useState("");
  const [weather, setWeather] = useState("");
  const [hasLocation, setHasLocation] = useState(false);
  const [locked, setLocked] = useState<string[]>([]);
  const [focusing, setFocusing] = useState(false);
  const [focusMinutes, setFocusMinutes] = useState(() => readTodayFocusMinutes());
  const [windowLine, setWindowLine] = useState(() => readWindowLine());
  const [footprint, setFootprint] = useState<HuaweiFootprintEntry[]>(() => loadHuaweiFootprint().slice(0, 5));
  const [diaries, setDiaries] = useState<DiaryEntry[]>([]);
  const [dots] = useState(() => readPeekCalendarDots());

  const companion = loadCharacters()[0];
  const cname = companion?.name || "TA";
  const companionMeta = readCompanionMeta();
  const dayCount = companionDayCount(companionMeta.startDate);
  const nextAnni = nextAnniversary(companionMeta.anniversaries);
  const timeRules = useMemo(
    () => loadHuaweiTriggerRules().filter(r => r.trigger === "time" && r.enabled && !!r.time),
    [],
  );

  /** 「下一件事」：最近一条已启用的定时提醒。 */
  const nextRule = useMemo(() => {
    const withDate = timeRules
      .map(r => ({ r, d: nextTriggerDate(r) }))
      .filter((x): x is { r: HuaweiTriggerRule; d: Date } => !!x.d)
      .sort((a, b) => a.d.getTime() - b.d.getTime());
    return withDate[0] || null;
  }, [timeRules]);

  const refresh = useCallback(() => {
    const avail = isHuaweiShellAvailable();
    setShellAvailable(avail);
    const shell = getAndroidShell();
    if (!avail || !shell) return;

    const st = invokeShellJson<Record<string, unknown>>(s => (s.getStatus ? s.getStatus() : null));
    if (st.ok) setStatus(st.data);
    const app = invokeShellJson<Record<string, unknown>>(s => (s.getCurrentApp ? s.getCurrentApp() : null));
    if (app.ok && typeof app.data.currentApp === "string") setCurrentApp(app.data.currentApp);
    const loc = invokeShellJson<Record<string, unknown>>(s => (s.getLocation ? s.getLocation() : null));
    setHasLocation(loc.ok && Number.isFinite(Number(loc.data.lat)) && Number.isFinite(Number(loc.data.lng)));
    if (typeof shell.isFocusing === "function") {
      try { setFocusing(!!shell.isFocusing()); } catch { /* 忽略 */ }
    }
    setLocked(readLockedPackagesFromShell());
    setFootprint(loadHuaweiFootprint().slice(0, 5));
    setWindowLine(readWindowLine());
    const cid = loadCharacters()[0]?.id;
    setDiaries(cid ? loadDiaryEntries().filter(e => e.characterId === cid).slice(0, 3) : []);
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

  const battery = statusNum(status, "battery");
  const network = statusBool(status, "network");
  const accessibility = statusBool(status, "accessibility");
  const floating = statusBool(status, "floating");

  const startFocus = useCallback(() => {
    const r = invokeShellJson(s => (s.focusMode ? s.focusMode(25) : null));
    if (r.ok) {
      onNotice?.("已开始 25 分钟专注");
      setFocusMinutes(addTodayFocusMinutes(25));
      setFocusing(true);
    } else {
      onNotice?.(r.error || "专注模式启动失败");
    }
  }, [onNotice]);

  const takeScreenBreak = useCallback(() => {
    const r = invokeShellJson(s => (s.screenBreak ? s.screenBreak(300) : null));
    onNotice?.(r.ok ? "护眼 5 分钟" : (r.error || "护眼休息启动失败"));
  }, [onNotice]);

  const triggerGuidian = useCallback(() => {
    const shell = getAndroidShell();
    if (!shell || typeof shell.ring !== "function") {
      onNotice?.("连接壳后才能归电");
      return;
    }
    try { shell.ring(15); } catch { /* 响铃失败不阻断事件 */ }
    try { window.dispatchEvent(new CustomEvent("ai-call-trigger", { detail: { type: "voice" } })); } catch { /* 忽略 */ }
    onNotice?.("归电：电话响起来啦");
  }, [onNotice]);

  const syncLocked = useCallback(() => {
    const list = readLockedPackagesFromShell();
    const r = pushLockedPackagesToShell(list);
    onNotice?.(r.ok ? `门禁列表已同步（${list.length} 个 App）` : (r.error || "门禁同步失败"));
  }, [onNotice]);

  /* 周期提醒 */
  const mConfig = loadMenstrualConfig();
  const mRecords = loadMenstrualRecords();
  let menstrualLabel = "未开启周期记录";
  if (mConfig.enabled) {
    if (mConfig.currentPeriodStartDate) {
      const start = new Date(`${mConfig.currentPeriodStartDate}T00:00:00`);
      const dayIdx = Math.max(1, Math.round((Date.now() - start.getTime()) / 86400000) + 1);
      menstrualLabel = `经期第 ${dayIdx} 天（自 ${mConfig.currentPeriodStartDate}）`;
    } else {
      const next = getNextPredictedPeriodStart(mRecords, mConfig);
      if (next) {
        const days = Math.round((new Date(`${next}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
        menstrualLabel = `下次预计 ${next}，还有 ${days} 天`;
      }
    }
  }

  /* 目标 App（web 无编辑入口，只读：登记为 open_app 的自定义动作） */
  const settings = loadHuaweiShellSettings();
  const targetApps = settings.customActions
    .filter(a => a.type === "open_app")
    .map(a => ({ name: a.name, pkg: a.packageName || a.openApp || "" }));

  /* 守护日历矩阵 */
  const nowDate = new Date();
  const year = nowDate.getFullYear();
  const month = nowDate.getMonth();
  const todayIso = formatIsoDate(nowDate);
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  /* 此刻状态：一段连贯文案，不是 key-value 表 */
  const nowSentence = useMemo(() => {
    const parts: string[] = [];
    parts.push(currentApp ? `你现在停在「${currentApp}」里。` : "这会儿你停在桌面上，哪里也没去。");
    const sys: string[] = [];
    if (network != null) sys.push(network ? "网络连着" : "网络断着");
    if (accessibility != null) sys.push(accessibility ? "无障碍开着" : "无障碍关着");
    if (floating != null) sys.push(floating ? "悬浮球在窗边" : "悬浮球收起来了");
    if (sys.length) parts.push(sys.join("，") + "。");
    if (hasLocation) parts.push("定位开着，她知道你走到哪儿了。");
    if (battery != null && battery < 20) parts.push("电量有点低，记得找个充电器。");
    return parts.join(" ");
  }, [currentApp, network, accessibility, floating, hasLocation, battery]);

  const dateSummary = `${month + 1}月${nowDate.getDate()}日 · ${"日一二三四五六"[nowDate.getDay()]}`;
  const latestFootprint = footprint[0];

  return (
    <div style={WINDOW_STYLE}>
      {/* 顶栏：左返回 + 标题 */}
      <div style={TITLEBAR}>
        <button type="button" onClick={onClose} aria-label="返回桌面" style={{
          border: "none", background: "transparent", color: INK,
          cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 2,
        }}>←</button>
        <span style={{ fontSize: 15 }}>🪟</span>
        <span>掌心窗</span>
      </div>

      {/* 三 Tab */}
      <div style={TABBAR}>
        {([["today", "今天"], ["companion", "陪伴"], ["guard", "守护"]] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} style={tab === id ? TAB_BTN_ON : TAB_BTN}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {!shellAvailable && (
          <div style={{ ...CARD, background: "rgba(255,244,228,.9)", borderColor: "rgba(240,180,110,.55)" }}>
            <div style={{ fontWeight: 800, color: "#9a6a2a", fontSize: 13 }}>未连接真机壳</div>
            <div style={{ fontSize: 12, color: "#8a6a40", marginTop: 4, lineHeight: 1.55 }}>
              请用壳 App 打开本站。连上 window.AndroidShell 后，电量、前台应用、天气、门禁会自动接入；窗语、陪伴天数、守护日历现在就能看。
            </div>
          </div>
        )}

        {/* ============ Tab 1 今天 ============ */}
        {tab === "today" && (
          <>
            {/* Hero 今日窗语 */}
            <div style={HERO}>
              <div style={LABEL}>今日窗语</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: INK, lineHeight: 1.45, marginTop: 8, whiteSpace: "pre-line" }}>
                {windowLine}
              </div>
              <div style={{ fontSize: 12, color: INK_SOFT, marginTop: 8, lineHeight: 1.6 }}>
                晚风会替你放下没有完成的事。
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 11.5, color: INK_FAINT }}>
                <span>☁️</span>
                <span>{dateSummary}</span>
                <span>·</span>
                <span>{weather || (shellAvailable ? "天气加载中…" : "连接壳后显示实时天气")}</span>
              </div>
              <button type="button" style={{ ...ACTION_BTN_GHOST, marginTop: 12 }}
                onClick={() => setWindowLine(nextWindowLine())}>
                换一句 ↻
              </button>
            </div>

            {/* 左右 mosaic：左宽 今日专注 / 右窄 窗外天气 + 下一件事 */}
            <div style={{ display: "flex", gap: 9, marginBottom: 12 }}>
              <div style={{ ...CARD, flex: "1.25 1 0", marginBottom: 0, display: "flex", flexDirection: "column" }}>
                <div style={LABEL}>今日专注</div>
                <div style={{ fontSize: 30, fontWeight: 800, color: ICE_DEEP, lineHeight: 1.1, marginTop: 6 }}>
                  {focusMinutes}<span style={{ fontSize: 13, color: INK_SOFT, fontWeight: 600 }}> 分</span>
                </div>
                <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 4 }}>
                  {focusing ? "专注中 · 今日累计" : "今日累计"} · 目标 {FOCUS_GOAL_MIN} 分钟
                </div>
                <div style={{
                  marginTop: "auto", height: 4, borderRadius: 2,
                  background: "rgba(126,200,255,.25)", overflow: "hidden",
                }}>
                  <div style={{
                    width: `${Math.min((focusMinutes / FOCUS_GOAL_MIN) * 100, 100)}%`,
                    height: "100%", borderRadius: 2,
                    background: `linear-gradient(90deg,${ICE},${ICE_DEEP})`,
                    transition: "width .4s",
                  }} />
                </div>
              </div>

              <div style={{ flex: "1 1 0", display: "flex", flexDirection: "column", gap: 9 }}>
                <div style={{ ...CARD, marginBottom: 0, flex: 1 }}>
                  <div style={{ ...LABEL, display: "flex", alignItems: "center", gap: 4 }}>☁️ 窗外</div>
                  <div style={{ fontSize: 11.5, color: INK, lineHeight: 1.5, marginTop: 6 }}>
                    {weather || (shellAvailable ? "加载中…" : "连壳后显示")}
                  </div>
                </div>
                <div style={{ ...CARD, marginBottom: 0, flex: 1 }}>
                  <div style={LABEL}>下一件事</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: INK, marginTop: 5 }}>
                    {nextRule ? nextRule.r.name : "晚间无安排"}
                  </div>
                  <div style={{ fontSize: 10.5, color: INK_FAINT, marginTop: 3 }}>
                    {nextRule ? triggerLabel(nextRule.d, nextRule.r.time!) : "把时间留给自己"}
                  </div>
                </div>
              </div>
            </div>

            {/* 手机电量横条 */}
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <BatteryIcon level={battery} />
                <span style={{ ...LABEL, marginRight: "auto" }}>手机电量</span>
                <span style={{ fontSize: 18, fontWeight: 800, color: INK }}>
                  {battery == null ? "—" : `${battery}%`}
                </span>
              </div>
              <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 6 }}>
                {battery == null
                  ? (shellAvailable ? "读取中…" : "连接壳后显示实时电量")
                  : battery < 20 ? "电量偏低，记得充电" : "电量稳稳的"}
              </div>
            </div>

            {/* 此刻状态：一段连贯文案 */}
            <div style={CARD}>
              <div style={{ fontSize: 15, fontWeight: 800, color: INK }}>此刻状态</div>
              <div style={{ fontSize: 12.5, color: INK_SOFT, lineHeight: 1.75, marginTop: 8 }}>{nowSentence}</div>
            </div>

            {/* 今日轨迹 */}
            <div style={{ display: "flex", alignItems: "baseline", margin: "2px 4px 8px" }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: INK }}>今日轨迹</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: INK_FAINT }}>全部</span>
            </div>
            <div style={CARD}>
              {footprint.length === 0 ? (
                <div style={{ fontSize: 12.5, color: INK_FAINT, lineHeight: 1.6 }}>
                  还没有行动记录，出门走动后会出现在这里。
                </div>
              ) : footprint.map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", fontSize: 12.5 }}>
                  <span style={{ color: ICE_DEEP, fontWeight: 800, minWidth: 42 }}>{FootprintTime(f.ts)}</span>
                  <span style={{ color: INK, flex: 1 }}>{f.placeName || f.semantic}</span>
                  <span style={{
                    fontSize: 10.5, padding: "2px 9px", borderRadius: 999,
                    background: "rgba(126,200,255,.2)", color: INK,
                  }}>{STATUS_LABEL[f.status] || f.status}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ============ Tab 2 陪伴 ============ */}
        {tab === "companion" && (
          <>
            {/* Hero 陪伴对象 */}
            <div style={HERO}>
              <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
                {companion?.avatar ? (
                  <img src={companion.avatar} alt="" style={{
                    width: 64, height: 64, borderRadius: 20, objectFit: "cover",
                    border: `2px solid ${ICE}`,
                  }} />
                ) : (
                  <span style={{
                    width: 64, height: 64, borderRadius: 20,
                    background: `linear-gradient(135deg,${ICE_LIGHT},${ICE_DEEP})`,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    fontSize: 26, color: "#fff",
                  }}>🤍</span>
                )}
                <div style={{ flex: 1 }}>
                  <div style={LABEL}>我的陪伴 · {cname}</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: INK, marginTop: 4 }}>{cname}在窗边</div>
                  <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 4 }}>
                    {latestFootprint
                      ? `最近 ${FootprintTime(latestFootprint.ts)} 在${latestFootprint.placeName || latestFootprint.semantic}`
                      : "正在窗边陪着你"}
                  </div>
                </div>
              </div>
              <div style={{
                marginTop: 13, display: "flex", alignItems: "center",
                background: "rgba(255,255,255,.7)", borderRadius: 12, padding: "8px 12px",
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#5fc98a" }}>● 正在陪伴</span>
              </div>
            </div>

            {/* 最近一句话 */}
            <div style={CARD}>
              <div style={LABEL}>最近一句话</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: INK, lineHeight: 1.6, marginTop: 10 }}>
                {windowLine}
              </div>
              <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 8 }}>{cname}留下</div>
            </div>

            {/* 左右 mosaic：左宽 和 TA 一起 / 右窄 下个纪念日 + 归电 */}
            <div style={{ display: "flex", gap: 9, marginBottom: 12 }}>
              <div style={{ ...CARD, flex: "1.22 1 0", marginBottom: 0, display: "flex", flexDirection: "column" }}>
                <div style={LABEL}>和{cname}一起</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: ICE_DEEP, marginTop: 6 }}>
                  {dayCount != null ? `第 ${dayCount} 天` : "第 1 天"}
                </div>
                <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 4 }}>
                  {companionMeta.startDate ? `从 ${companionMeta.startDate} 开始` : "从今天开始"}
                </div>
              </div>
              <div style={{ flex: "1 1 0", display: "flex", flexDirection: "column", gap: 9 }}>
                <div style={{ ...CARD, marginBottom: 0, flex: 1 }}>
                  <div style={LABEL}>下个纪念日</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: INK, marginTop: 6, lineHeight: 1.4 }}>
                    {nextAnni ? (
                      <>{nextAnni.name}<br /><span style={{ color: ICE_DEEP, fontSize: 16 }}>{nextAnni.daysLeft}</span> 天后 · {nextAnni.label}</>
                    ) : (
                      <span style={{ fontWeight: 500, fontSize: 12, color: INK_FAINT }}>还没有纪念日</span>
                    )}
                  </div>
                </div>
                <div style={{ ...CARD, marginBottom: 0, flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
                  <div style={{ ...LABEL, textAlign: "center" }}>🔋 归电</div>
                  <button type="button" style={{ ...ACTION_BTN_GHOST, marginTop: 6, padding: "6px 14px", fontSize: 11 }}
                    onClick={triggerGuidian}>
                    让{ cname }敲门
                  </button>
                </div>
              </div>
            </div>

            {/* TA 的行动 */}
            <div style={CARD}>
              <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>{cname}的行动</div>
              <div style={{ fontSize: 12.5, color: INK_FAINT, lineHeight: 1.7, marginTop: 10 }}>
                还没有新的行动记录。
              </div>
            </div>

            {/* 更多陪伴 */}
            <div style={GROUP_TITLE}>更多陪伴</div>
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>📖</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>TA 的日记</div>
                  <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 2 }}>把今天看见的你，轻轻写下来。</div>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                {diaries.length === 0 ? (
                  <div style={{ fontSize: 12, color: INK_FAINT, padding: "6px 0" }}>TA 还没有写下日记。</div>
                ) : diaries.map(d => (
                  <div key={d.id} style={{ padding: "8px 0", borderTop: "1px dashed rgba(126,200,255,.3)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{d.title || "无标题"}</span>
                      <span style={{ fontSize: 10.5, color: INK_FAINT, whiteSpace: "nowrap" }}>
                        {d.dateLabel}{d.mood ? ` · ${d.mood}` : ""}
                      </span>
                    </div>
                    <div style={{ fontSize: 11.5, color: INK_SOFT, marginTop: 4, lineHeight: 1.55 }}>
                      {d.body.split(/\n+/).filter(Boolean).slice(0, 2).join(" ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>🔋</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>归电</div>
                  <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 2 }}>很久没回来时，{cname}来敲门。</div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ============ Tab 3 守护 ============ */}
        {tab === "guard" && (
          <>
            <div style={GROUP_TITLE}>守护功能</div>

            <div style={LABEL}>日子与地点</div>
            {/* 守护日历：内嵌当月矩阵 */}
            <div style={{ ...CARD, marginTop: 6 }}>
              <div style={{ display: "flex", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: INK }}>{year} 年 {month + 1} 月 · 守护日历</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: INK_FAINT }}>有痕迹的日子画圆点</span>
              </div>
              <div style={{
                display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3,
                textAlign: "center", fontSize: 11, color: INK_FAINT, marginTop: 10,
              }}>
                {["日", "一", "二", "三", "四", "五", "六"].map(d => <div key={d} style={{ padding: "2px 0" }}>{d}</div>)}
                {cells.map((day, i) => {
                  if (day == null) return <div key={`e${i}`} />;
                  const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                  const isToday = iso === todayIso;
                  const hasDot = dots.has(iso);
                  return (
                    <div key={iso} style={{
                      padding: "5px 0", borderRadius: 10, fontSize: 12, position: "relative",
                      background: isToday ? `linear-gradient(135deg,${ICE},${ICE_DEEP})` : "transparent",
                      color: isToday ? "#fff" : INK, fontWeight: isToday ? 800 : 400,
                    }}>
                      {day}
                      {hasDot && (
                        <span style={{
                          position: "absolute", bottom: 1, left: "50%", transform: "translateX(-50%)",
                          width: 4, height: 4, borderRadius: "50%",
                          background: isToday ? "#fff" : ICE_DEEP,
                        }} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 天气地区 */}
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>☁️</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>天气地区</div>
                  <div style={{ fontSize: 11.5, color: INK_SOFT, marginTop: 3, lineHeight: 1.5 }}>
                    {weather || (shellAvailable ? "天气加载中…" : "连接壳后显示当前天气")}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ ...LABEL, margin: "6px 0" }}>安心规则</div>

            {/* 目标 App（只读） */}
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>🎯</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>目标 App 设置</div>
                  <div style={{ fontSize: 11.5, color: INK_SOFT, marginTop: 3, lineHeight: 1.5 }}>
                    {targetApps.length === 0
                      ? "还没有登记目标 App"
                      : targetApps.map(t => `${t.name}（${t.pkg || "未填包名"}）`).join("、")}
                  </div>
                </div>
              </div>
            </div>

            {/* 应用门禁 */}
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>🛡️</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>应用门禁</div>
                  <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 2 }}>需要时轻轻守住</div>
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                {locked.length === 0 ? (
                  <div style={{ fontSize: 12, color: INK_FAINT }}>还没有锁定的 App。</div>
                ) : locked.map(pkg => (
                  <div key={pkg} style={{ fontSize: 12, color: INK, padding: "3px 0" }}>🔒 {pkg}</div>
                ))}
              </div>
              <button type="button" style={{ ...ACTION_BTN_GHOST, marginTop: 10 }} onClick={syncLocked}>
                同步门禁列表到壳
              </button>
            </div>

            {/* 屏幕休息 + 专注模式 */}
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>🌙</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>屏幕休息</div>
                  <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 2 }}>让眼睛歇一会儿</div>
                </div>
              </div>
              <button type="button" style={{ ...ACTION_BTN, marginTop: 10 }} onClick={takeScreenBreak}>
                护眼 5 分钟
              </button>
            </div>

            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>🎧</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>专注模式</div>
                  <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 2 }}>
                    {focusing ? "正在专注中" : "当前未在专注"}
                  </div>
                </div>
              </div>
              <button type="button" style={{ ...ACTION_BTN, marginTop: 10 }} onClick={startFocus}>
                专注 25 分钟
              </button>
            </div>

            {/* 主动提醒 */}
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>⏰</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>主动提醒</div>
                  <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 2 }}>电量、休息与喝水</div>
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                {timeRules.length === 0 ? (
                  <div style={{ fontSize: 12, color: INK_FAINT }}>没有已启用的定时提醒。</div>
                ) : timeRules.map(rule => {
                  const d = nextTriggerDate(rule);
                  return (
                    <div key={rule.id} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "5px 0", fontSize: 12.5, borderTop: "1px dashed rgba(126,200,255,.3)",
                    }}>
                      <span style={{ color: INK }}>{rule.name}</span>
                      <span style={{ color: ICE_DEEP, fontWeight: 700 }}>
                        {d ? triggerLabel(d, rule.time!) : rule.time || "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 周期提醒 */}
            <div style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>💗</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>周期提醒</div>
                  <div style={{ fontSize: 11.5, color: INK_SOFT, marginTop: 3 }}>{menstrualLabel}</div>
                </div>
              </div>
            </div>

            {/* 收尾卡 */}
            <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 12, marginBottom: 0 }}>
              <span style={{ fontSize: 26 }}>🐱</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: INK }}>Je t'aime.</div>
                <div style={{ fontSize: 11, color: INK_FAINT, marginTop: 3 }}>掌心窗里的守护，轻一点就够了。</div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
