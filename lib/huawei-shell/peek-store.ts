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
const PEEK_COMPANION_NAME_KEY = "ai_phone_peek_companion_name_v1";
const PEEK_CUSTOM_LINES_KEY = "ai_phone_peek_window_lines_custom_v1";
const PEEK_COMPANION_ACTION_KEY = "ai_phone_peek_companion_actions_v1";
const PEEK_FOCUS_GOAL_KEY = "ai_phone_peek_focus_goal_v1";
const PEEK_FOCUS_DURATION_KEY = "ai_phone_peek_focus_duration_v1";
const PEEK_CALL_SETTINGS_KEY = "ai_phone_peek_call_settings_v1";

registerKvMigration(PEEK_WINDOW_KEY);
registerKvMigration(PEEK_CHAR_WINDOW_KEY);
registerKvMigration(PEEK_FOCUS_KEY);
registerKvMigration(PEEK_COMPANION_KEY);
registerKvMigration(PEEK_GUARD_EVENT_KEY);
registerKvMigration(PEEK_COMPANION_NAME_KEY);
registerKvMigration(PEEK_CUSTOM_LINES_KEY);
registerKvMigration(PEEK_COMPANION_ACTION_KEY);
registerKvMigration(PEEK_FOCUS_GOAL_KEY);
registerKvMigration(PEEK_FOCUS_DURATION_KEY);
registerKvMigration(PEEK_CALL_SETTINGS_KEY);

/* ---------- 今日窗语：内置语料 + 用户自定义语料，合并轮换 ---------- */

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

/** 用户自定义窗语语料（设置里可增删），与内置语料合并后一起轮换。 */
export function readCustomWindowLines(): string[] {
  try {
    const raw = kvGet(PEEK_CUSTOM_LINES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr
      .map(item => (typeof item === "string" ? item.trim() : ""))
      .filter(t => t.length > 0)
      .slice(0, 40);
  } catch { return []; }
}

/** 整体替换自定义窗语语料（空数组 = 只用内置）。 */
export function setCustomWindowLines(lines: string[]): void {
  const clean = Array.from(new Set(
    lines.map(l => String(l ?? "").trim().slice(0, 60)).filter(t => t.length > 0),
  )).slice(0, 40);
  try { kvSet(PEEK_CUSTOM_LINES_KEY, JSON.stringify(clean)); } catch { /* 存不下下次再写 */ }
}

/** 参与轮换的完整语料：内置 + 用户自定义（去重）。 */
function allWindowLines(): string[] {
  const custom = readCustomWindowLines();
  const merged = [...PEEK_WINDOW_LINES];
  for (const line of custom) if (!merged.includes(line)) merged.push(line);
  return merged;
}

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
  const pool = allWindowLines();
  try {
    const raw = kvGet(PEEK_WINDOW_KEY);
    if (!raw) return pool[0];
    const idx = Number((JSON.parse(raw) as { index?: number }).index);
    if (!Number.isFinite(idx)) return pool[0];
    return pool[((idx % pool.length) + pool.length) % pool.length];
  } catch {
    return pool[0];
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
  const pool = allWindowLines();
  let idx = 0;
  try {
    const raw = kvGet(PEEK_WINDOW_KEY);
    if (raw) idx = Number((JSON.parse(raw) as { index?: number }).index) || 0;
  } catch { idx = 0; }
  idx = (idx + 1) % pool.length;
  try { kvSet(PEEK_WINDOW_KEY, JSON.stringify({ index: idx })); } catch { /* 存不下就下次再转 */ }
  // 用户手动换一句 = 今天不再用 char 写的那句，语料轮换接管
  try { kvSet(PEEK_CHAR_WINDOW_KEY, ""); } catch { /* 忽略 */ }
  return pool[idx];
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

/** 今日专注目标分钟数（进度条分母），默认 120。 */
export function readFocusGoalMin(): number {
  try {
    const raw = kvGet(PEEK_FOCUS_GOAL_KEY);
    if (!raw) return 120;
    const n = Number(JSON.parse(raw));
    return Number.isFinite(n) && n >= 15 && n <= 960 ? Math.round(n) : 120;
  } catch { return 120; }
}

/** 设置今日专注目标分钟数（15-960）。 */
export function setFocusGoalMin(minutes: number): void {
  const n = Math.max(15, Math.min(960, Math.round(Number(minutes) || 120)));
  try { kvSet(PEEK_FOCUS_GOAL_KEY, JSON.stringify(n)); } catch { /* 忽略写失败 */ }
}

/* ---------- 陪伴：起始日 + 纪念日列表 ---------- */

export type PeekAnniversary = { name: string; date: string }; // date = MM-DD
export type PeekCompanionMeta = { startDate: string | null; anniversaries: PeekAnniversary[]; avatar: string };

export function readCompanionMeta(): PeekCompanionMeta {
  const fallback: PeekCompanionMeta = { startDate: null, anniversaries: [], avatar: "" };
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
      avatar: typeof p.avatar === "string" ? p.avatar.trim().slice(0, 600000) : "",
    };
  } catch { return fallback; }
}

/** 设置（或清除）陪伴起始日，保留已有纪念日与头像。null = 清除。 */
export function setCompanionStartDate(iso: string | null): void {
  if (iso !== null && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  const current = readCompanionMeta();
  try {
    kvSet(PEEK_COMPANION_KEY, JSON.stringify({ startDate: iso, anniversaries: current.anniversaries, avatar: current.avatar }));
  } catch { /* 存不下就下次再写 */ }
}

/** 设置陪伴头像（单源：陪伴卡片 / 归电来电 / 悬浮窗共用）。空串 = 清除，回退心形占位。 */
export function setCompanionAvatar(url: string): void {
  const clean = String(url ?? "").trim().slice(0, 600000);
  const current = readCompanionMeta();
  try {
    kvSet(PEEK_COMPANION_KEY, JSON.stringify({ startDate: current.startDate, anniversaries: current.anniversaries, avatar: clean }));
  } catch { /* 存不下就下次再写 */ }
}

/** 加一个纪念日（MM-DD），同名同日去重，返回更新后的 meta。 */
export function addCompanionAnniversary(name: string, dateMMDD: string): PeekCompanionMeta {
  const cleanName = String(name ?? "").trim().slice(0, 20);
  const cleanDate = String(dateMMDD ?? "").trim();
  const current = readCompanionMeta();
  if (cleanName && /^\d{2}-\d{2}$/.test(cleanDate)) {
    if (!current.anniversaries.some(a => a.name === cleanName && a.date === cleanDate)) {
      current.anniversaries.push({ name: cleanName, date: cleanDate });
      current.anniversaries.sort((a, b) => a.date.localeCompare(b.date));
      current.anniversaries = current.anniversaries.slice(0, 12);
      try { kvSet(PEEK_COMPANION_KEY, JSON.stringify(current)); } catch { /* 忽略写失败 */ }
    }
  }
  return current;
}

/** 删一个纪念日（按 name + date 精确匹配），返回更新后的 meta。 */
export function removeCompanionAnniversary(name: string, dateMMDD: string): PeekCompanionMeta {
  const current = readCompanionMeta();
  current.anniversaries = current.anniversaries.filter(a => !(a.name === name && a.date === dateMMDD));
  try { kvSet(PEEK_COMPANION_KEY, JSON.stringify(current)); } catch { /* 忽略写失败 */ }
  return current;
}

/* ---------- 陪伴对象称呼：掌心窗内可改的显示名，覆盖角色默认名 ---------- */

/** 读陪伴对象在掌心窗里的显示称呼；没设过回退 fallback（角色名或 TA）。 */
export function readCompanionName(fallback?: string): string {
  try {
    const raw = kvGet(PEEK_COMPANION_NAME_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { name?: string };
      if (typeof parsed.name === "string" && parsed.name.trim()) return parsed.name.trim().slice(0, 12);
    }
  } catch { /* 读失败回退 */ }
  return fallback?.trim() || "TA";
}

/** 设置掌心窗里的陪伴称呼；传空串 = 清掉自定义、回退角色名。 */
export function setCompanionName(name: string): void {
  const clean = String(name ?? "").trim().slice(0, 12);
  try { kvSet(PEEK_COMPANION_NAME_KEY, JSON.stringify({ name: clean })); } catch { /* 忽略写失败 */ }
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

export type PeekGuardEvent = {
  date: string;            // YYYY-MM-DD
  title: string;
  remindDaysBefore?: number; // 提前几天提醒（0=当天）
  remindTime?: string;       // 提醒时刻 HH:MM
};

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
  return upsertPeekGuardEvent(date, clean, undefined, undefined);
}

/** 新增或更新一条守护日历事件（同 date+title 覆盖提醒字段），返回最新列表。 */
export function upsertPeekGuardEvent(
  date: string,
  title: string,
  remindDaysBefore?: number,
  remindTime?: string,
): PeekGuardEvent[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return readPeekGuardEvents();
  const clean = String(title ?? "").trim().slice(0, 40);
  if (!clean) return readPeekGuardEvents();
  const events = loadGuardEvents();
  const idx = events.findIndex(e => e.date === date && e.title === clean);
  const ev: PeekGuardEvent = {
    date,
    title: clean,
    ...(Number.isFinite(remindDaysBefore) ? { remindDaysBefore: Math.max(0, Math.min(30, Math.round(remindDaysBefore as number))) } : {}),
    ...(typeof remindTime === "string" && /^\d{2}:\d{2}$/.test(remindTime) ? { remindTime } : {}),
  };
  if (idx >= 0) events[idx] = { ...events[idx], ...ev };
  else events.push(ev);
  events.sort((a, b) => a.date.localeCompare(b.date));
  try { kvSet(PEEK_GUARD_EVENT_KEY, JSON.stringify(events)); } catch { /* 忽略写失败 */ }
  return events;
}

/** 删掉一条守护日历事件（按 date+title 精确匹配）。 */
export function removePeekGuardEvent(date: string, title: string): PeekGuardEvent[] {
  const events = loadGuardEvents().filter(e => !(e.date === date && e.title === title));
  try { kvSet(PEEK_GUARD_EVENT_KEY, JSON.stringify(events)); } catch { /* 忽略写失败 */ }
  return events;
}

export function readPeekGuardEvents(): PeekGuardEvent[] {
  return loadGuardEvents();
}

/* ---------- 陪伴行动流：陪伴页「TA 的行动」时间线 ---------- */

export type PeekCompanionAction = { ts: number; text: string };

function loadCompanionActions(): PeekCompanionAction[] {
  try {
    const raw = kvGet(PEEK_COMPANION_ACTION_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return (arr as Array<Record<string, unknown>>).filter((item): item is PeekCompanionAction =>
      typeof item === "object" && item !== null
      && typeof item.ts === "number" && Number.isFinite(item.ts)
      && typeof item.text === "string" && item.text.trim().length > 0,
    ).slice(-30);
  } catch { return []; }
}

/** 读最近的陪伴行动（新的在前）。 */
export function readCompanionActions(): PeekCompanionAction[] {
  return loadCompanionActions().slice().reverse();
}

/** 记一条陪伴行动（如「给你泡了杯热水」「把灯调暗了」），返回新列表。 */
export function addCompanionAction(text: string): PeekCompanionAction[] {
  const clean = String(text ?? "").trim().slice(0, 60);
  if (!clean) return readCompanionActions();
  const list = loadCompanionActions();
  list.push({ ts: Date.now(), text: clean });
  const trimmed = list.slice(-30);
  try { kvSet(PEEK_COMPANION_ACTION_KEY, JSON.stringify(trimmed)); } catch { /* 忽略写失败 */ }
  return trimmed.slice().reverse();
}

/* ---------- 专注模式可选时长（15 / 25 / 45 分钟） ---------- */

const FOCUS_DURATION_CHOICES = [15, 25, 45] as const;
export type FocusDurationChoice = typeof FOCUS_DURATION_CHOICES[number];

export function readFocusDurationMin(): FocusDurationChoice {
  try {
    const raw = kvGet(PEEK_FOCUS_DURATION_KEY);
    if (!raw) return 25;
    const n = Number(JSON.parse(raw));
    return (FOCUS_DURATION_CHOICES as readonly number[]).includes(n) ? n as FocusDurationChoice : 25;
  } catch { return 25; }
}

export function setFocusDurationMin(minutes: number): void {
  const n = Number(minutes);
  if (!(FOCUS_DURATION_CHOICES as readonly number[]).includes(n)) return;
  try { kvSet(PEEK_FOCUS_DURATION_KEY, JSON.stringify(n)); } catch { /* 忽略写失败 */ }
}

/* ---------- 归电（来电覆盖层）样式与行为配置 ---------- */

export type PeekCallSettings = {
  /** char 名字覆盖；空 = 用掌心窗称呼 */
  charName: string;
  /** 来电副标题文案，{name} 会替换成 char 名字 */
  headline: string;
  /** 背景：preset:ocean / preset:sunset / preset:night / preset:peach，或任意图片 URL */
  background: string;
  /** 是否在来电页显示用户头像 */
  showUserAvatar: boolean;
  /** 来电时是否响铃+震动（调壳 ring） */
  ringEnabled: boolean;
  /** 接听按钮底色（css 渐变或颜色） */
  acceptColor: string;
  /** 挂断按钮底色（css 渐变或颜色） */
  hangupColor: string;
};

export const PEEK_CALL_BACKGROUNDS: Record<string, { label: string; css: string }> = {
  ocean: { label: "深海", css: "linear-gradient(180deg,#2c4a6e 0%,#4aa8ef 55%,#7ec8ff 100%)" },
  sunset: { label: "落日", css: "linear-gradient(180deg,#3a2c6e 0%,#e86a8a 55%,#ffb87e 100%)" },
  night: { label: "星夜", css: "linear-gradient(180deg,#0b1020 0%,#1e2f52 60%,#3a4a7a 100%)" },
  peach: { label: "蜜桃", css: "linear-gradient(180deg,#ff9a8b 0%,#ff6a88 55%,#ff99ac 100%)" },
};

const DEFAULT_CALL_SETTINGS: PeekCallSettings = {
  charName: "",
  headline: "{name}想和你说说话",
  background: "preset:ocean",
  showUserAvatar: false,
  ringEnabled: true,
  acceptColor: "linear-gradient(135deg,#63d68f,#37b568)",
  hangupColor: "linear-gradient(135deg,#ff8a8a,#e84545)",
};

function normalizeUrlish(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function readCallSettings(): PeekCallSettings {
  try {
    const raw = kvGet(PEEK_CALL_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_CALL_SETTINGS };
    const p = JSON.parse(raw) as Partial<PeekCallSettings>;
    return {
      charName: typeof p.charName === "string" ? p.charName.trim().slice(0, 12) : "",
      headline: typeof p.headline === "string" && p.headline.trim() ? p.headline.trim().slice(0, 40) : DEFAULT_CALL_SETTINGS.headline,
      background: typeof p.background === "string" && p.background.trim() ? p.background.trim().slice(0, 500) : DEFAULT_CALL_SETTINGS.background,
      showUserAvatar: p.showUserAvatar === true,
      ringEnabled: p.ringEnabled !== false,
      acceptColor: normalizeUrlish(p.acceptColor, 200) || DEFAULT_CALL_SETTINGS.acceptColor,
      hangupColor: normalizeUrlish(p.hangupColor, 200) || DEFAULT_CALL_SETTINGS.hangupColor,
    };
  } catch { return { ...DEFAULT_CALL_SETTINGS }; }
}

export function saveCallSettings(next: PeekCallSettings): void {
  const clean: PeekCallSettings = {
    charName: typeof next.charName === "string" ? next.charName.trim().slice(0, 12) : "",
    headline: typeof next.headline === "string" && next.headline.trim() ? next.headline.trim().slice(0, 40) : DEFAULT_CALL_SETTINGS.headline,
    background: typeof next.background === "string" && next.background.trim() ? next.background.trim().slice(0, 500) : DEFAULT_CALL_SETTINGS.background,
    showUserAvatar: next.showUserAvatar === true,
    ringEnabled: next.ringEnabled !== false,
    acceptColor: normalizeUrlish(next.acceptColor, 200) || DEFAULT_CALL_SETTINGS.acceptColor,
    hangupColor: normalizeUrlish(next.hangupColor, 200) || DEFAULT_CALL_SETTINGS.hangupColor,
  };
  try { kvSet(PEEK_CALL_SETTINGS_KEY, JSON.stringify(clean)); } catch { /* 忽略写失败 */ }
}
