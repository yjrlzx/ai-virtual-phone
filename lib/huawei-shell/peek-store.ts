"use client";

/** 掌心窗（float 桌面小组件）专属的轻量本地存储。
 *  只放「今天 / 陪伴 / 守护」三 Tab 自己的 kv：窗语轮换下标、当日累计专注分钟、
 *  陪伴起始日与纪念日列表。不碰华为壳桥与业务主存储（storage.ts / types.ts 不动）。 */

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { formatIsoDate, parseIsoDate } from "../calendar-utils";
import { loadHuaweiFootprint } from "./storage";
import { loadMenstrualRecords } from "../menstrual-storage";

const PEEK_WINDOW_KEY = "ai_phone_peek_window_line_v1";
const PEEK_CHAR_WINDOW_KEY = "ai_phone_peek_char_window_v1";
const PEEK_FOCUS_KEY = "ai_phone_peek_focus_minutes_v1";
const PEEK_COMPANION_KEY = "ai_phone_peek_companion_v1";
const PEEK_GUARD_EVENT_KEY = "ai_phone_peek_guard_events_v1";

registerKvMigration(PEEK_WINDOW_KEY);
registerKvMigration(PEEK_CHAR_WINDOW_KEY);
registerKvMigration(PEEK_FOCUS_KEY);
registerKvMigration(PEEK_COMPANION_KEY);
registerKvMigration(PEEK_GUARD_EVENT_KEY);

/* ---------- 今日窗语：语料库 + 轮换下标 ---------- */

export const PEEK_WINDOW_LINES: string[] = [
  "把今天，轻轻收进窗里。",
  "窗外有风也有光，你慢慢来。",
  "今天也要好好吃饭，好好休息。",
  "窗这边我在，窗外你在，刚刚好。",
  "走慢一点，风景才认得清。",
  "累了就抬头看看天，它一直都在。",
  "今天的你，也已经很努力了。",
  "把心事放下一会儿，窗里很安静。",
];

/** 读当前窗语：char 当天写过的优先；否则走语料轮换下标。 */
export function readWindowLine(): string {
  try {
    const raw = kvGet(PEEK_CHAR_WINDOW_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { date?: string; text?: string };
      if (parsed.date === formatIsoDate(new Date()) && typeof parsed.text === "string" && parsed.text.trim()) {
        return parsed.text.trim();
      }
    }
  } catch { /* 读 char 窗语失败则回落语料轮换 */ }
  try {
    const raw = kvGet(PEEK_WINDOW_KEY);
    if (!raw) return PEEK_WINDOW_LINES[0];
    const idx = Number((JSON.parse(raw) as { index?: number }).index);
    if (!Number.isFinite(idx)) return PEEK_WINDOW_LINES[0];
    return PEEK_WINDOW_LINES[((idx % PEEK_WINDOW_LINES.length) + PEEK_WINDOW_LINES.length) % PEEK_WINDOW_LINES.length];
  } catch {
    return PEEK_WINDOW_LINES[0];
  }
}

/** char 主动为今天写一句窗语（只覆盖当天；次日自动回落到语料轮换）。 */
export function setTodayWindowLine(text: string): void {
  const clean = String(text ?? "").trim().slice(0, 60);
  if (!clean) return;
  try {
    kvSet(PEEK_CHAR_WINDOW_KEY, JSON.stringify({ date: formatIsoDate(new Date()), text: clean }));
  } catch { /* 存不下就下次再写 */ }
}

/** 顺时针换一句窗语并落盘，返回新文案。 */
export function nextWindowLine(): string {
  let idx = 0;
  try {
    const raw = kvGet(PEEK_WINDOW_KEY);
    if (raw) idx = Number((JSON.parse(raw) as { index?: number }).index) || 0;
  } catch { idx = 0; }
  idx = (idx + 1) % PEEK_WINDOW_LINES.length;
  try { kvSet(PEEK_WINDOW_KEY, JSON.stringify({ index: idx })); } catch { /* 存不下就下次再转 */ }
  // 用户手动换一句 = 今天不再用 char 写的那句，语料轮换接管
  try { kvSet(PEEK_CHAR_WINDOW_KEY, ""); } catch { /* 忽略 */ }
  return PEEK_WINDOW_LINES[idx];
}

/* ---------- 当日累计专注分钟（按 YYYY-MM-DD 记账） ---------- */

type FocusMap = Record<string, number>;

function loadFocusMap(): FocusMap {
  try {
    const raw = kvGet(PEEK_FOCUS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: FocusMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  } catch { return {}; }
}

export function readTodayFocusMinutes(): number {
  return loadFocusMap()[formatIsoDate(new Date())] || 0;
}

/** 一次专注结束后累加分钟数，返回今日累计。 */
export function addTodayFocusMinutes(minutes: number): number {
  const map = loadFocusMap();
  const today = formatIsoDate(new Date());
  map[today] = (map[today] || 0) + Math.max(0, Math.round(minutes));
  try { kvSet(PEEK_FOCUS_KEY, JSON.stringify(map)); } catch { /* 忽略写失败 */ }
  return map[today];
}

/* ---------- 陪伴：起始日 + 纪念日列表 ---------- */

export type PeekAnniversary = { name: string; date: string }; // date = MM-DD
export type PeekCompanionMeta = { startDate: string | null; anniversaries: PeekAnniversary[] };

export function readCompanionMeta(): PeekCompanionMeta {
  const fallback: PeekCompanionMeta = { startDate: null, anniversaries: [] };
  try {
    const raw = kvGet(PEEK_COMPANION_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<PeekCompanionMeta>;
    const anniversaries = Array.isArray(p.anniversaries)
      ? (p.anniversaries as unknown[]).filter((item): item is PeekAnniversary => {
        if (!item || typeof item !== "object") return false;
        const r = item as Record<string, unknown>;
        return typeof r.name === "string" && typeof r.date === "string" && /^\d{2}-\d{2}$/.test(r.date);
      }).slice(0, 12)
      : [];
    return {
      startDate: typeof p.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.startDate) ? p.startDate : null,
      anniversaries,
    };
  } catch { return fallback; }
}

/** 设置（或清除）陪伴起始日，保留已有纪念日列表。null = 清除。 */
export function setCompanionStartDate(iso: string | null): void {
  if (iso !== null && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  const current = readCompanionMeta();
  try {
    kvSet(PEEK_COMPANION_KEY, JSON.stringify({ startDate: iso, anniversaries: current.anniversaries }));
  } catch { /* 存不下就下次再写 */ }
}

/** 从起始日到今天的陪伴第几天（含今天）；没设起始日返回 null。 */
export function companionDayCount(startDate: string | null): number | null {
  if (!startDate) return null;
  const start = parseIsoDate(startDate).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((today - start) / 86400000);
  return diff >= 0 ? diff + 1 : null;
}

export type NextAnniversary = { name: string; daysLeft: number; label: string };

/** 纪念日列表里最近的一个（今年已过就顺到明年）；空列表返回 null。 */
export function nextAnniversary(anniversaries: PeekAnniversary[]): NextAnniversary | null {
  if (anniversaries.length === 0) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let best: NextAnniversary | null = null;
  for (const a of anniversaries) {
    const month = Number(a.date.slice(0, 2));
    const day = Number(a.date.slice(3, 5));
    if (!month || !day) continue;
    let target = new Date(now.getFullYear(), month - 1, day).getTime();
    if (target < today) target = new Date(now.getFullYear() + 1, month - 1, day).getTime();
    const daysLeft = Math.round((target - today) / 86400000);
    if (!best || daysLeft < best.daysLeft) {
      best = { name: a.name, daysLeft, label: `${month}月${day}日` };
    }
  }
  return best;
}

/* ---------- 守护日历打点：当天有足迹或经期记录就画小圆点 ---------- */

export function readPeekCalendarDots(): Set<string> {
  const dots = new Set<string>();
  try {
    for (const f of loadHuaweiFootprint()) {
      if (Number.isFinite(f.ts)) dots.add(formatIsoDate(new Date(f.ts)));
    }
    for (const r of loadMenstrualRecords()) {
      if (r.startDate) dots.add(r.startDate);
      if (r.endDate) dots.add(r.endDate);
    }
    for (const e of readPeekGuardEvents()) {
      dots.add(e.date);
    }
  } catch { /* 拿不到打点数据就空日历 */ }
  return dots;
}

/* ---------- 守护日历事件：char 在守护日历上画一个有名字的日子 ---------- */

export type PeekGuardEvent = { date: string; title: string };

function loadGuardEvents(): PeekGuardEvent[] {
  try {
    const raw = kvGet(PEEK_GUARD_EVENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return (arr as Array<Record<string, unknown>>).filter((item): item is PeekGuardEvent =>
      typeof item === "object" && item !== null
      && typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date)
      && typeof item.title === "string" && item.title.trim().length > 0,
    ).slice(0, 120);
  } catch { return []; }
}

/** 在指定日子加一条守护日历事件（同一天同名去重），返回写入后的事件列表。 */
export function addPeekGuardEvent(date: string, title: string): PeekGuardEvent[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return readPeekGuardEvents();
  const clean = String(title ?? "").trim().slice(0, 40);
  if (!clean) return readPeekGuardEvents();
  const events = loadGuardEvents();
  if (!events.some(e => e.date === date && e.title === clean)) {
    events.push({ date, title: clean });
    events.sort((a, b) => a.date.localeCompare(b.date));
    try { kvSet(PEEK_GUARD_EVENT_KEY, JSON.stringify(events)); } catch { /* 忽略写失败 */ }
  }
  return events;
}

export function readPeekGuardEvents(): PeekGuardEvent[] {
  return loadGuardEvents();
}
