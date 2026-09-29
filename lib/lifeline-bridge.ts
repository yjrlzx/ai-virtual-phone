"use client";

/**
 * Lifeline 学习生活记录桥（主应用侧）。
 *
 * Lifeline 在本项目里有两种落盘形态，本文件同时提供两条读写通道：
 *
 * 1) 静态 iframe 形态：public/lifeline/index.html 以同源 iframe 挂载
 *    （components/lifeline-app.tsx），与父窗口共享 localStorage，
 *    整份状态存在 localStorage 键 `lifeLineState_v2`（页面内 saveDB() 即
 *    localStorage.setItem(DB_KEY, JSON.stringify(state))）。
 *    readLifeLineState / mutateLifeLineState / appendLifelineFinanceRecord 等
 *    历史函数走这条通道，tool-executor.ts 已经在用。
 *
 * 2) 自定义 APP 形态（float 宿主）：Lifeline 作为 manifest id = "lifeline" 的
 *    已安装自定义 APP，数据落在 kv-db 的集合
 *    `ai_phone_custom_app_data_v1:{cleanId(appId)}/lifeline`，值是 JSON 数组，
 *    主状态在 id === "lifeLineState_v2" 那一行的 value（JSON 字符串）。
 *    findLifelineAppId / readLifelineState / updateLifelineState 等新契约函数
 *    走这条通道；未安装时全部容错返回 null / 空结果。
 *
 * 不改动 public/lifeline/index.html 一行；Lifeline 页面下次打开时自然读到新数据。
 */

import { kvGet, kvSet } from "./kv-db";
import {
  loadInstalledCustomApps,
  readCustomAppCollection,
  writeCustomAppCollection,
} from "./custom-app-storage";

const LIFE_LINE_KEY = "lifeLineState_v2";
const LIFELINE_MANIFEST_ID = "lifeline";
const LIFELINE_COLLECTION = "lifeline";
const STATE_ROW_ID = "lifeLineState_v2";

/* ---------- Lifeline 状态类型 ---------- */

export type LifelineFinanceRecord = {
    id: string;
    date: string;          // YYYY-MM-DD
    type: "expense" | "income";
    amount: number;
    method?: string;
    category?: string;
    note?: string;
};

export type LifelineTask = {
    id: string;
    text: string;
    done: boolean;
    mins: number;
};

export type LifelineDayTasks = {
    morning: LifelineTask[];
    afternoon: LifelineTask[];
    evening: LifelineTask[];
};

/** 自定义 APP 形态下的主状态类型（契约导出）。 */
export type LifelineState = {
    tasks?: Record<string, LifelineDayTasks>;
    finances?: {
        initial?: Record<string, number>;
        records?: LifelineFinanceRecord[];
        budgets?: Record<string, number>;
    };
    diet?: Record<string, unknown[]>;
    body?: Array<{ date: string; weight: number }>;
    targetWeight?: number;
    errors?: Record<string, { name?: string; items: unknown[] }>;
    knowledge?: Record<string, { name?: string; items: unknown[] }>;
    habits?: Array<{ id: string; name: string }>;
    milestones?: unknown[];
    settings?: Record<string, unknown>;
    [k: string]: unknown;
};

type LifelineErrorGroup = {
    items?: Array<Record<string, unknown>>;
    tree?: Record<string, Record<string, Array<Record<string, unknown>>>>;
};

/** 历史状态类型（localStorage 通道），字段与 LifelineState 兼容。 */
export type LifeLineState = {
    tasks?: Record<string, LifelineDayTasks>;
    finances?: {
        initial?: Record<string, number>;
        records?: LifelineFinanceRecord[];
        budgets?: Record<string, number>;
    };
    errors?: Record<string, LifelineErrorGroup>;
    [k: string]: unknown;
};

function uid(): string {
    return `ll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 本地时区 YYYY-MM-DD。 */
export function localDateKey(d: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------- localStorage 通道（历史，tool-executor 在用） ---------- */

/** 读取 localStorage 里的 lifeLineState_v2；不存在或解析失败返回 null（不抛异常）。 */
export function readLifeLineState(): LifeLineState | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = localStorage.getItem(LIFE_LINE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return null;
        return parsed as LifeLineState;
    } catch {
        return null;
    }
}

/** 读-改-写整份 localStorage 状态：mutator 内可安全改 draft 的字段；返回是否写成功。 */
export function mutateLifeLineState(mutator: (draft: LifeLineState) => void): boolean {
    if (typeof window === "undefined") return false;
    try {
        const raw = localStorage.getItem(LIFE_LINE_KEY);
        const draft: LifeLineState = raw
            ? ((JSON.parse(raw) as unknown) as LifeLineState)
            : {};
        if (!draft || typeof draft !== "object") return false;
        mutator(draft);
        localStorage.setItem(LIFE_LINE_KEY, JSON.stringify(draft));
        return true;
    } catch {
        return false;
    }
}

/* ---------- 自定义 APP collection 通道（新契约） ---------- */

/** 扫描已安装应用，返回 manifest.id === "lifeline" 的运行时 app.id；找不到返回 null。 */
export function findLifelineAppId(): string | null {
    try {
        const apps = loadInstalledCustomApps();
        const found = apps.find(app => app && app.manifest && app.manifest.id === LIFELINE_MANIFEST_ID);
        return found ? found.id : null;
    } catch {
        return null;
    }
}

/** 读取 collection 里 lifeLineState_v2 那一行；未安装 / 无数据 / 解析失败返回 null。 */
export function readLifelineState(): LifelineState | null {
    try {
        const appId = findLifelineAppId();
        if (!appId) return null;
        const rows = readCustomAppCollection(appId, LIFELINE_COLLECTION);
        const row = rows.find(r => r && r.id === STATE_ROW_ID);
        if (!row || typeof row.value !== "string") return null;
        const parsed = JSON.parse(row.value) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as LifelineState;
    } catch {
        return null;
    }
}

/**
 * 读-改-写 collection 里的 lifeLineState_v2 行：读出整个 collection 数组 →
 * 改目标行的 value → 整包写回，其余行原样保留。未安装返回 null。
 */
export function updateLifelineState(mutate: (state: LifelineState) => void): LifelineState | null {
    try {
        const appId = findLifelineAppId();
        if (!appId) return null;
        const rows = readCustomAppCollection(appId, LIFELINE_COLLECTION);
        const row = rows.find(r => r && r.id === STATE_ROW_ID);
        let draft: LifelineState = {};
        if (row && typeof row.value === "string") {
            try {
                const parsed = JSON.parse(row.value) as unknown;
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    draft = parsed as LifelineState;
                }
            } catch { draft = {}; }
        }
        mutate(draft);
        const value = JSON.stringify(draft);
        let found = false;
        const next = rows.map(r => {
            if (r && r.id === STATE_ROW_ID) { found = true; return { ...r, value }; }
            return r;
        });
        if (!found) next.push({ id: STATE_ROW_ID, value });
        writeCustomAppCollection(appId, LIFELINE_COLLECTION, next);
        return draft;
    } catch {
        return null;
    }
}

/* ---------- 财务：追加一笔 / 读取 ---------- */

/** 合法消费分类（与 lifeline/index.html 的 BUDGET_CATS 对齐）。 */
export const LIFELINE_FINANCE_CATEGORIES = ["餐饮", "零食", "饮料", "购物", "交通", "娱乐", "学习", "其他"] as const;

function normalizeCategory(category: string): string {
    const c = category.trim();
    return (LIFELINE_FINANCE_CATEGORIES as readonly string[]).includes(c) ? c : "其他";
}

export type AppendFinanceInput = {
    amount: number;
    category?: string;
    note?: string;
    method?: string;
    type?: "expense" | "income";
    date?: string;
};

/**
 * 往 Lifeline 财务 records 追加一笔（localStorage 通道写，collection 通道尽力同步）。
 * 始终返回新记录；金额非数时按 0 处理但仍返回记录（不抛异常）。
 */
export function appendLifelineFinanceRecord(input: AppendFinanceInput): LifelineFinanceRecord {
    const amount = Math.round((Number(input.amount) || 0) * 100) / 100;
    const record: LifelineFinanceRecord = {
        id: uid(),
        date: input.date || localDateKey(),
        type: input.type === "income" ? "income" : "expense",
        amount,
    };
    if (input.method) record.method = input.method;
    record.category = normalizeCategory(input.category || "其他");
    if (input.note) record.note = input.note.trim().slice(0, 80);
    // 主写：localStorage（iframe 形态，tool-executor 已在用）
    mutateLifeLineState(draft => {
        if (!draft.finances || typeof draft.finances !== "object") draft.finances = {};
        if (!Array.isArray(draft.finances.records)) draft.finances.records = [];
        draft.finances.records.push(record);
    });
    // 尽力同步：自定义 APP collection 形态
    try {
        updateLifelineState(state => {
            const finances = state.finances && typeof state.finances === "object" ? state.finances : {};
            const records = Array.isArray(finances.records) ? [...finances.records] : [];
            records.push(record);
            state.finances = { ...finances, records };
        });
    } catch { /* 同步失败不阻断 */ }
    return record;
}

export type LifelineFinanceView = {
    records: LifelineFinanceRecord[];
    todayTotal: number;
    monthTotal: number;
};

/** 读取最近 N 条财务记录 + 今日支出合计 + 本月支出合计。 */
export function readLifelineFinance(limit = 20): LifelineFinanceView {
    const empty: LifelineFinanceView = { records: [], todayTotal: 0, monthTotal: 0 };
    const state = readLifeLineState();
    const all = state?.finances?.records;
    if (!Array.isArray(all) || all.length === 0) return empty;
    const sorted = all.slice().sort((a, b) =>
        a.date === b.date ? (b.id > a.id ? 1 : -1) : (a.date > b.date ? -1 : 1));
    const tk = localDateKey();
    const monthPrefix = tk.slice(0, 7);
    let todayTotal = 0;
    let monthTotal = 0;
    for (const r of all) {
        if (r.type !== "expense") continue;
        if (r.date === tk) todayTotal += Number(r.amount) || 0;
        if (typeof r.date === "string" && r.date.startsWith(monthPrefix)) monthTotal += Number(r.amount) || 0;
    }
    return {
        records: sorted.slice(0, Math.max(1, limit)),
        todayTotal: Math.round(todayTotal * 100) / 100,
        monthTotal: Math.round(monthTotal * 100) / 100,
    };
}

/* ---------- 学习进度 ---------- */

const ERR_SUBJ_LABELS: Record<string, string> = {
    finance: "431 金融学",
    math: "数学",
    english: "英语",
    politics: "政治",
};

function countErrorGroup(group: LifelineErrorGroup | undefined): number {
    if (!group) return 0;
    if (group.tree) {
        let total = 0;
        for (const byYear of Object.values(group.tree)) {
            for (const list of Object.values(byYear)) {
                if (Array.isArray(list)) total += list.length;
            }
        }
        return total;
    }
    return Array.isArray(group.items) ? group.items.length : 0;
}

/** 汇总今日任务、错题本各科数量、近 7 天学习时长（localStorage 通道）。 */
export function readLifelineStudyProgress(): string {
    const state = readLifeLineState();
    if (!state) return "Lifeline 还没有数据（首次打开 Lifeline 后会自动建库）。";
    const lines: string[] = [];
    const tk = localDateKey();

    const day = state.tasks?.[tk];
    if (day) {
        const buckets: Array<["morning" | "afternoon" | "evening", string]> = [
            ["morning", "上午"], ["afternoon", "下午"], ["evening", "晚上"],
        ];
        const taskLines: string[] = [];
        let done = 0;
        let total = 0;
        for (const [key, label] of buckets) {
            const list = Array.isArray(day[key]) ? day[key] : [];
            for (const t of list) {
                total++;
                if (t.done) done++;
                const mark = t.done ? "✓" : "○";
                taskLines.push(`  ${mark} ${label} ${t.text}${t.mins ? ` ${t.mins}分钟` : ""}`);
            }
        }
        lines.push(`【今日任务 ${done}/${total} 已完成】`);
        lines.push(taskLines.length ? taskLines.join("\n") : "  （今天还没有任务）");
    } else {
        lines.push("【今日任务】今天还没有安排任务。");
    }

    const errors = state.errors || {};
    const errParts: string[] = [];
    for (const key of ["finance", "math", "english", "politics"]) {
        const n = countErrorGroup(errors[key]);
        errParts.push(`${ERR_SUBJ_LABELS[key] || key} ${n} 道`);
    }
    lines.push(`【错题本】${errParts.join("，")}`);

    let weekMinutes = 0;
    let weekDoneTasks = 0;
    const tasks = state.tasks || {};
    for (let i = 0; i < 7; i++) {
        const dk = localDateKey(new Date(Date.now() - i * 86400000));
        const dayTasks = tasks[dk];
        if (!dayTasks) continue;
        for (const list of [dayTasks.morning, dayTasks.afternoon, dayTasks.evening]) {
            if (!Array.isArray(list)) continue;
            for (const t of list) {
                if (t.done) {
                    weekDoneTasks++;
                    weekMinutes += Number(t.mins) || 0;
                }
            }
        }
    }
    lines.push(`【近 7 天】完成 ${weekDoneTasks} 项，累计学习约 ${weekMinutes} 分钟。`);

    return lines.join("\n");
}

/** 追加一条学习记录：在今天的时段桶里 push 一个已完成任务。 */
export function appendLifelineStudyRecord(input: { subject: string; content: string; minutes: number }): boolean {
    const content = input.content.trim();
    if (!content) return false;
    const minutes = Math.max(0, Math.round(Number(input.minutes) || 0));
    const hour = new Date().getHours();
    const period: "morning" | "afternoon" | "evening" = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    const task: LifelineTask = {
        id: uid(),
        text: content.slice(0, 60),
        done: true,
        mins: minutes,
    };
    return mutateLifeLineState(draft => {
        if (!draft.tasks || typeof draft.tasks !== "object") draft.tasks = {};
        const dk = localDateKey();
        if (!draft.tasks[dk]) draft.tasks[dk] = { morning: [], afternoon: [], evening: [] };
        const day = draft.tasks[dk];
        if (!Array.isArray(day[period])) day[period] = [];
        day[period].push(task);
    });
}

/* ---------- 契约：取某日任务 / 进度摘要 ---------- */

/* ---------- char 长期记忆（kv-db，跨会话保留） ---------- */

export const CHAR_MEMORY_KEY = "char_memory_v1";

export type CharMemoryEntry = {
    key: string;
    category: string;
    text: string;
    ts: number;
};

export function readCharMemory(): CharMemoryEntry[] {
    try {
        const raw = kvGet(CHAR_MEMORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return (parsed as CharMemoryEntry[])
            .filter(e => e && typeof e.text === "string")
            .slice(-500);
    } catch {
        return [];
    }
}

/** 记一条偏好/事实；category 如「作息/数学薄弱/喜好」。 */
export function rememberCharMemory(category: string, text: string): CharMemoryEntry | null {
    const entry: CharMemoryEntry = {
        key: uid(),
        category: category.trim().slice(0, 20) || "其他",
        text: text.trim().slice(0, 300),
        ts: Date.now(),
    };
    if (!entry.text) return null;
    const next = [...readCharMemory(), entry].slice(-500);
    kvSet(CHAR_MEMORY_KEY, JSON.stringify(next));
    return entry;
}

/* ---------- 本地日程（壳未连接时降级暂存手机日历事件） ---------- */

export const LOCAL_SCHEDULE_KEY = "huawei_scheduled_events_v1";

export type LocalScheduleEvent = {
    id: string;
    title: string;
    date: string;       // YYYY-MM-DD
    startTime: string;  // HH:mm
    endTime: string;    // HH:mm
    note: string;
    createdAt: number;
};

export function readLocalScheduleEvents(): LocalScheduleEvent[] {
    try {
        const raw = kvGet(LOCAL_SCHEDULE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return (parsed as LocalScheduleEvent[]).slice(-200);
    } catch {
        return [];
    }
}

export function appendLocalScheduleEvent(ev: Omit<LocalScheduleEvent, "id" | "createdAt">): LocalScheduleEvent {
    const entry: LocalScheduleEvent = { ...ev, id: uid(), createdAt: Date.now() };
    const next = [...readLocalScheduleEvents(), entry].slice(-200);
    kvSet(LOCAL_SCHEDULE_KEY, JSON.stringify(next));
    return entry;
}

/* ---------- 起床闹钟（kv-db，调度器与向导卡片共用） ---------- */

export const WAKE_ALARM_KEY = "huawei_wake_alarm_v1";

export type WakeAlarmConfig = {
    enabled: boolean;
    time: string;        // HH:mm
    message: string;
    lastFiredDate: string; // YYYY-MM-DD，同一天只响一次
};

export function loadWakeAlarm(): WakeAlarmConfig {
    const fallback: WakeAlarmConfig = { enabled: false, time: "07:00", message: "", lastFiredDate: "" };
    try {
        const raw = kvGet(WAKE_ALARM_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw) as Partial<WakeAlarmConfig>;
        return {
            enabled: parsed.enabled === true,
            time: typeof parsed.time === "string" && /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : "07:00",
            message: typeof parsed.message === "string" ? parsed.message : "",
            lastFiredDate: typeof parsed.lastFiredDate === "string" ? parsed.lastFiredDate : "",
        };
    } catch {
        return fallback;
    }
}

export function saveWakeAlarm(cfg: WakeAlarmConfig): void {
    kvSet(WAKE_ALARM_KEY, JSON.stringify(cfg));
}
