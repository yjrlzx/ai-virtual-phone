"use client";

/**
 * Lifeline 每日记录的类型化读写层（主应用 / char 工具侧）。
 *
 * 整份状态存在云端 KV 键 `lifeLineState_v2`（经 lib/kv-db → /api/kv/* → SQLite）。
 * 这里把所有数据整形逻辑收敛在一处：字段名严格对齐 lifeline/index.html 的真实形状
 * （defaultState / saveRecord / addDietRecord / saveBodyRecord / saveTask / saveErrFromModal），
 * 不臆造字段，不硬编码业务数据。
 *
 * 旧的浏览器 localStorage 副本会在 kv-db 水合时自动上传云端后清除。
 */

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const LIFE_LINE_KEY = "lifeLineState_v2";

// 首次水合时把浏览器里残留的 lifeLineState_v2 上传到云端，然后删掉 localStorage 副本。
if (typeof window !== "undefined") {
  registerKvMigration(LIFE_LINE_KEY);
}

/* ---------- 类型（只声明我们读写的字段，其余透传） ---------- */

export type LifelineFinanceMethod = "wechat" | "alipay" | "cash";
export type LifelineFinanceType = "expense" | "income";

export type LifelineFinanceRecord = {
    id: string;
    date: string;          // YYYY-MM-DD
    type: LifelineFinanceType;
    amount: number;
    method: LifelineFinanceMethod;
    category: string;
    note: string;
};

export type LifelineTaskPeriod = "morning" | "afternoon" | "evening";

/**
 * 任务真实形状（saveTask）：{id,name,completed,priority,color,subject,duration,note}。
 * 历史种子数据存在旧形状 {id,text,done,mins}，读取时两者兼容。
 */
export type LifelineTask = {
    id: string;
    name?: string;
    completed?: boolean;
    priority?: string;
    color?: string;
    subject?: string;
    duration?: number;
    note?: string;
    // 旧种子行兼容字段
    text?: string;
    done?: boolean;
    mins?: number;
};

export type LifelineDayTasks = {
    morning?: LifelineTask[];
    afternoon?: LifelineTask[];
    evening?: LifelineTask[];
};

/** 饮食记录（addDietRecord）：{id,meal,cat,food,price} */
export type LifelineDietRecord = {
    id: string;
    meal: string;      // 早餐/午餐/晚餐/加餐/饮品
    cat: string;       // 正餐/零食/饮料
    food: string;
    price: number;     // 元，0 表示未标价
};

/** 体重记录（saveBodyRecord）：按日期 upsert，morning/night 为早晚称重，weight 取其一 */
export type LifelineBodyRecord = {
    date: string;            // YYYY-MM-DD
    morning: number | null;
    night: number | null;
    weight: number;
};

export type LifelineErrorStatus = "未掌握" | "模糊" | "已掌握";

/** 错题条目（saveErrFromModal / migrateErrors） */
export type LifelineErrorItem = {
    id: string;
    date: string;
    type: string;
    source: string;
    q: string;
    options: string[];
    wrong: string;
    right: string;
    analysis: string;
    latex: boolean;
    status: LifelineErrorStatus | string;
};

export type LifelineErrorGroup = {
    name?: string;
    items?: LifelineErrorItem[];
    tree?: Record<string, Record<string, unknown[]>>;
};

export type LifelineState = {
    tasks?: Record<string, LifelineDayTasks>;
    finances?: {
        initial?: Partial<Record<LifelineFinanceMethod, number>>;
        records?: LifelineFinanceRecord[];
        budgets?: Record<string, number>;
    };
    diet?: Record<string, LifelineDietRecord[]>;
    water?: Record<string, number>;
    body?: LifelineBodyRecord[];
    targetWeight?: number | null;
    errors?: Record<string, LifelineErrorGroup>;
    [k: string]: unknown;
};

/* ---------- 基础工具（与 lifeline/index.html 同语义） ---------- */

/** 与 lifeline uid() 同格式：时间戳 36 进制 + 5 位随机。 */
export function lifelineUid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 本地时区 YYYY-MM-DD（与 lifeline dkey(new Date()) 一致）。 */
export function lifelineTodayKey(d: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** N 天前（含今天）的日期键数组，key[0]=今天。 */
export function lifelineRecentKeys(days: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < days; i++) {
        out.push(lifelineTodayKey(new Date(Date.now() - i * 86400000)));
    }
    return out;
}

/* ---------- 读 / 写整份状态 ---------- */

/** 空结构骨架：与 defaultState() 对齐的最小可用形状（字段缺失时补空容器）。 */
function emptyLifelineState(): LifelineState {
    return {
        tasks: {},
        finances: { initial: { wechat: 0, alipay: 0, cash: 0 }, records: [], budgets: {} },
        diet: {},
        water: {},
        body: [],
        targetWeight: null,
        errors: {},
    };
}

/** 读取 lifeLineState_v2；缺失/损坏时返回与 defaultState 对齐的空结构（不抛异常）。 */
export function loadLifelineState(): LifelineState {
    if (typeof window === "undefined") return emptyLifelineState();
    try {
        const raw = kvGet(LIFE_LINE_KEY);
        if (!raw) return emptyLifelineState();
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyLifelineState();
        return parsed as LifelineState;
    } catch {
        return emptyLifelineState();
    }
}

/** 整份写回云端 KV（等价 lifeline 的 saveDB()）。 */
export function saveLifelineState(state: LifelineState): void {
    if (typeof window === "undefined") return;
    kvSet(LIFE_LINE_KEY, JSON.stringify(state));
}

/** 读-改-写：mutator 内安全改 draft，返回是否写成功。 */
function mutateLifelineState(mutator: (draft: LifelineState) => void): boolean {
    if (typeof window === "undefined") return false;
    try {
        const draft = loadLifelineState();
        mutator(draft);
        saveLifelineState(draft);
        return true;
    } catch {
        return false;
    }
}

/* ---------- 财务 ---------- */

/** 与 lifeline/index.html 的 EXP_CATS / INC_CATS 对齐。 */
export const LIFELINE_EXPENSE_CATEGORIES = ["餐饮", "交通", "购物", "学习", "娱乐", "医疗", "人情", "其他"];
export const LIFELINE_INCOME_CATEGORIES = ["生活费", "兼职", "奖学金", "红包", "其他"];

function normalizeFinanceCategory(category: unknown, type: LifelineFinanceType): string {
    const c = typeof category === "string" ? category.trim() : "";
    const pool = type === "income" ? LIFELINE_INCOME_CATEGORIES : LIFELINE_EXPENSE_CATEGORIES;
    return pool.includes(c) ? c : "其他";
}

function normalizeMethod(method: unknown): LifelineFinanceMethod {
    return method === "wechat" || method === "alipay" || method === "cash" ? method : "wechat";
}

export type AppendFinanceInput = {
    amount: number;
    category?: string;
    note?: string;
    method?: LifelineFinanceMethod;
    type?: LifelineFinanceType;
    date?: string;
};

/** 追加一笔财务记录（读旧 JSON → push → 写回）。金额必须 > 0，返回新记录；失败返回 null。 */
export function appendLifelineFinanceRecord(input: AppendFinanceInput): LifelineFinanceRecord | null {
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const type: LifelineFinanceType = input.type === "income" ? "income" : "expense";
    const record: LifelineFinanceRecord = {
        id: lifelineUid(),
        date: typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : lifelineTodayKey(),
        type,
        amount,
        method: normalizeMethod(input.method),
        category: normalizeFinanceCategory(input.category, type),
        note: (input.note || "").toString().trim().slice(0, 80),
    };
    const ok = mutateLifelineState(draft => {
        if (!draft.finances || typeof draft.finances !== "object") draft.finances = {};
        if (!Array.isArray(draft.finances.records)) draft.finances.records = [];
        draft.finances.records.push(record);
    });
    return ok ? record : null;
}

export type FinanceSummary = {
    records: LifelineFinanceRecord[];
    todayTotal: number;
    windowTotal: number;
};

/** 读取最近 N 天（默认 7 天、可按 category 过滤）的支出记录 + 今日支出合计 + 窗口内支出合计。 */
export function readLifelineFinanceSummary(options: { days?: number; category?: string } = {}): FinanceSummary {
    const empty: FinanceSummary = { records: [], todayTotal: 0, windowTotal: 0 };
    const state = loadLifelineState();
    const all = state.finances?.records;
    if (!Array.isArray(all) || all.length === 0) return empty;
    const days = Math.max(1, Math.min(120, Math.round(options.days ?? 7)));
    const keys = new Set(lifelineRecentKeys(days));
    const cat = typeof options.category === "string" && options.category.trim() ? options.category.trim() : "";
    const tk = lifelineTodayKey();
    const filtered = all.filter(r => {
        if (!r || r.type !== "expense") return false;
        if (!keys.has(r.date)) return false;
        if (cat && r.category !== cat) return false;
        return true;
    });
    const records = filtered.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1)));
    let todayTotal = 0;
    let windowTotal = 0;
    for (const r of filtered) {
        const amt = Number(r.amount) || 0;
        windowTotal += amt;
        if (r.date === tk) todayTotal += amt;
    }
    return {
        records,
        todayTotal: Math.round(todayTotal * 100) / 100,
        windowTotal: Math.round(windowTotal * 100) / 100,
    };
}

/* ---------- 饮食 ---------- */

/** meal 入参归一到 lifeline 的五种：早餐/午餐/晚餐/加餐/饮品。 */
function normalizeMeal(meal: unknown): { meal: string; cat: string } {
    const m = typeof meal === "string" ? meal.trim() : "";
    if (m.includes("早")) return { meal: "早餐", cat: "正餐" };
    if (m.includes("午")) return { meal: "午餐", cat: "正餐" };
    if (m.includes("晚")) return { meal: "晚餐", cat: "正餐" };
    if (m.includes("饮") || m.includes("奶") || m.includes("茶") || m.includes("咖啡")) return { meal: "饮品", cat: "饮料" };
    return { meal: "加餐", cat: "零食" };
}

export type AppendDietInput = {
    food: string;
    meal?: string;
    price?: number;
    date?: string;
};

/**
 * 追加一条饮食记录（与 lifeline addDietRecord 同形）：
 * diet[date].push({id,meal,cat,food,price})；price>0 时 lifeline 自己会同步记一笔「餐饮」支出，
 * 这里保持同样行为，避免两边账对不上。
 */
export function appendLifelineDietRecord(input: AppendDietInput): LifelineDietRecord | null {
    const food = (input.food || "").toString().trim();
    if (!food) return null;
    const { meal, cat } = normalizeMeal(input.meal);
    const price = Math.max(0, Math.round((Number(input.price) || 0) * 100) / 100);
    const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : lifelineTodayKey();
    const rec: LifelineDietRecord = { id: lifelineUid(), meal, cat, food: food.slice(0, 60), price };
    const ok = mutateLifelineState(draft => {
        if (!draft.diet || typeof draft.diet !== "object") draft.diet = {};
        if (!Array.isArray(draft.diet[date])) draft.diet[date] = [];
        draft.diet[date]!.push(rec);
        // 与 lifeline addDietRecord 一致：标价食物同步一笔餐饮支出
        if (price > 0) {
            if (!draft.finances || typeof draft.finances !== "object") draft.finances = {};
            if (!Array.isArray(draft.finances.records)) draft.finances.records = [];
            draft.finances.records.push({
                id: lifelineUid(), date, type: "expense", amount: price,
                method: "wechat", category: "餐饮", note: `${cat}·${food.slice(0, 40)}`,
            });
        }
    });
    return ok ? rec : null;
}

/** 读取某天的饮食记录（默认今天）。 */
export function readLifelineDiet(date?: string): LifelineDietRecord[] {
    const dk = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : lifelineTodayKey();
    const state = loadLifelineState();
    const list = state.diet?.[dk];
    return Array.isArray(list) ? list : [];
}

/* ---------- 体重 ---------- */

export type AppendWeightInput = {
    weight: number;          // 斤
    date?: string;
    slot?: "morning" | "night";   // 早上空腹 / 晚上睡前，默认早上
    target?: number;         // 可选：同时设置目标体重（斤）
};

/** 记录体重：同一天 upsert（与 lifeline saveBodyRecord 同逻辑）。返回该日体重行。 */
export function appendLifelineWeight(input: AppendWeightInput): LifelineBodyRecord | null {
    const weight = Number(input.weight);
    if (!Number.isFinite(weight) || weight <= 0) return null;
    const dk = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : lifelineTodayKey();
    const slot: "morning" | "night" = input.slot === "night" ? "night" : "morning";
    let result: LifelineBodyRecord | null = null;
    const ok = mutateLifelineState(draft => {
        if (!Array.isArray(draft.body)) draft.body = [];
        let row = draft.body.find(r => r && r.date === dk);
        if (!row) {
            row = { date: dk, morning: null, night: null, weight: 0 };
            draft.body.push(row);
        }
        if (slot === "morning") row.morning = Math.round(weight * 10) / 10;
        else row.night = Math.round(weight * 10) / 10;
        row.weight = row.morning || row.night || row.weight;
        const tw = Number(input.target);
        if (Number.isFinite(tw) && tw > 0) draft.targetWeight = Math.round(tw * 10) / 10;
        result = row;
    });
    return ok ? result : null;
}

/** 体重概览：最新一条 + 目标体重。 */
export function readLifelineBodySummary(): { latest: LifelineBodyRecord | null; target: number | null; count: number } {
    const state = loadLifelineState();
    const list = Array.isArray(state.body) ? state.body : [];
    return {
        latest: list.length > 0 ? list[list.length - 1] : null,
        target: typeof state.targetWeight === "number" ? state.targetWeight : null,
        count: list.length,
    };
}

/* ---------- 学习任务 ---------- */

const PERIOD_LABEL: Record<LifelineTaskPeriod, string> = { morning: "上午", afternoon: "下午", evening: "晚上" };

function normalizePeriod(p: unknown): LifelineTaskPeriod {
    const s = typeof p === "string" ? p.trim() : "";
    if (s === "morning" || s.includes("早")) return "morning";
    if (s === "evening" || s.includes("晚") || s.includes("夜")) return "evening";
    return "afternoon";
}

/** 兼容新旧两种行形状，读出展示用字段。 */
export function describeTask(t: LifelineTask): { name: string; done: boolean; minutes: number; subject: string } {
    return {
        name: t.name || t.text || "(未命名任务)",
        done: t.completed !== undefined ? !!t.completed : !!t.done,
        minutes: Number(t.duration ?? t.mins) || 0,
        subject: t.subject || "",
    };
}

export type TaskDayView = {
    date: string;
    done: number;
    total: number;
    items: Array<{ period: LifelineTaskPeriod; name: string; done: boolean; minutes: number; subject: string; id: string }>;
};

/** 读取学习计划：指定 date 单天，或最近 days 天（默认今天+明天=2 天）。 */
export function readLifelineTaskPlan(options: { date?: string; days?: number } = {}): TaskDayView[] {
    const state = loadLifelineState();
    const out: TaskDayView[] = [];
    const dkList: string[] = [];
    if (typeof options.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
        dkList.push(options.date);
    } else {
        const days = Math.max(1, Math.min(14, Math.round(options.days ?? 2)));
        // days=2 时 = 今天+明天：从今天起向后
        for (let i = 0; i < days; i++) {
            dkList.push(lifelineTodayKey(new Date(Date.now() + i * 86400000)));
        }
    }
    for (const dk of dkList) {
        const day = state.tasks?.[dk];
        const view: TaskDayView = { date: dk, done: 0, total: 0, items: [] };
        for (const period of ["morning", "afternoon", "evening"] as LifelineTaskPeriod[]) {
            const list = Array.isArray(day?.[period]) ? day![period]! : [];
            for (const t of list) {
                const d = describeTask(t);
                view.total++;
                if (d.done) view.done++;
                view.items.push({ period, ...d, id: String(t.id || "") });
            }
        }
        out.push(view);
    }
    return out;
}

export type AddTaskInput = {
    name: string;
    date?: string;
    period?: string;        // morning/afternoon/evening，或 上午/下午/晚上
    subject?: string;
    duration?: number;      // 分钟
    priority?: string;
    completed?: boolean;    // 默认 false
};

/** 新增一条学习任务。返回新任务；name 为空返回 null。 */
export function addLifelineTask(input: AddTaskInput): LifelineTask | null {
    const name = (input.name || "").toString().trim();
    if (!name) return null;
    const dk = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : lifelineTodayKey();
    const period = normalizePeriod(input.period);
    const task: LifelineTask = {
        id: lifelineUid(),
        name: name.slice(0, 60),
        completed: input.completed === true,
        priority: input.priority === "high" ? "high" : "normal",
        subject: (input.subject || "").toString().trim().slice(0, 20) || undefined,
        duration: Math.max(0, Math.round(Number(input.duration) || 0)),
        note: "",
    };
    const ok = mutateLifelineState(draft => {
        if (!draft.tasks || typeof draft.tasks !== "object") draft.tasks = {};
        if (!draft.tasks[dk]) draft.tasks[dk] = { morning: [], afternoon: [], evening: [] };
        const day = draft.tasks[dk]!;
        if (!Array.isArray(day[period])) day[period] = [];
        day[period]!.push(task);
    });
    return ok ? task : null;
}

/**
 * 把任务标记完成。两种定位方式：
 * - taskId：精确按 id（跨天查找，与 lifeline findTask 一致）；
 * - 否则按 date（默认今天）+ 名称关键词模糊匹配第一个未完成任务。
 */
export function completeLifelineTask(input: { taskId?: string; keyword?: string; date?: string }): LifelineTask | null {
    const targetId = typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : "";
    const keyword = typeof input.keyword === "string" && input.keyword.trim() ? input.keyword.trim() : "";
    let found: LifelineTask | null = null;
    const ok = mutateLifelineState(draft => {
        const tasks = draft.tasks || {};
        const dkList = Object.keys(tasks);
        for (const dk of dkList) {
            const day = tasks[dk];
            if (!day) continue;
            for (const period of ["morning", "afternoon", "evening"] as LifelineTaskPeriod[]) {
                const arr = day[period];
                if (!Array.isArray(arr)) continue;
                for (const t of arr) {
                    if (targetId) {
                        if (String(t.id) === targetId) { t.completed = true; found = t; return; }
                    } else if (keyword && (!input.date || dk === input.date || dk === lifelineTodayKey())) {
                        const d = describeTask(t);
                        if (!d.done && d.name.includes(keyword)) { t.completed = true; found = t; return; }
                    }
                }
            }
        }
    });
    return ok ? found : null;
}

/* ---------- 错题本 ---------- */

export const LIFELINE_ERROR_SUBJECTS = ["finance", "math", "english", "politics"] as const;
export type LifelineErrorSubject = (typeof LIFELINE_ERROR_SUBJECTS)[number];

export const LIFELINE_ERROR_SUBJ_LABELS: Record<LifelineErrorSubject, string> = {
    finance: "金融学",
    math: "数学",
    english: "英语",
    politics: "政治",
};

function normalizeErrorSubject(subject: unknown): LifelineErrorSubject | null {
    const s = typeof subject === "string" ? subject.trim().toLowerCase() : "";
    if (s === "finance" || s === "金融" || s === "金融学" || s === "431") return "finance";
    if (s === "math" || s === "数学" || s === "数三") return "math";
    if (s === "english" || s === "英语" || s === "英") return "english";
    if (s === "politics" || s === "政治" || s === "政") return "politics";
    return null;
}

export type AppendErrorInput = {
    subject: string;
    q: string;
    options?: string[];
    wrong?: string;
    right?: string;
    analysis?: string;
    type?: string;
    source?: string;
    date?: string;
};

/** 录入一道错题到对应学科 items（与 lifeline saveErrFromModal 同形）。 */
export function appendLifelineError(input: AppendErrorInput): LifelineErrorItem | null {
    const subj = normalizeErrorSubject(input.subject);
    const q = (input.q || "").toString().trim();
    if (!subj || !q) return null;
    const options = Array.isArray(input.options) ? input.options.map(o => String(o)).slice(0, 12) : [];
    const item: LifelineErrorItem = {
        id: lifelineUid(),
        date: typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : lifelineTodayKey(),
        type: (input.type || "").toString().trim().slice(0, 20),
        source: (input.source || "").toString().trim().slice(0, 30),
        q: q.slice(0, 500),
        options,
        wrong: (input.wrong || "").toString().trim().slice(0, 200),
        right: (input.right || "").toString().trim().slice(0, 200),
        analysis: (input.analysis || "").toString().trim().slice(0, 1000),
        latex: false,
        status: "未掌握",
    };
    const ok = mutateLifelineState(draft => {
        if (!draft.errors || typeof draft.errors !== "object") draft.errors = {};
        if (!draft.errors[subj]) draft.errors[subj] = { name: LIFELINE_ERROR_SUBJ_LABELS[subj], items: [] };
        const g = draft.errors[subj]!;
        if (!Array.isArray(g.items)) g.items = [];
        g.items.push(item);
    });
    return ok ? item : null;
}

export type ReadErrorsOptions = {
    subject?: string;
    status?: string;
};

/** 读取错题本：可按学科、按掌握状态筛选；返回按时间倒序的扁平列表。 */
export function readLifelineErrors(options: ReadErrorsOptions = {}): Array<LifelineErrorItem & { subject: LifelineErrorSubject; subjectName: string }> {
    const state = loadLifelineState();
    const subj = normalizeErrorSubject(options.subject);
    const status = typeof options.status === "string" && options.status.trim() ? options.status.trim() : "";
    const out: Array<LifelineErrorItem & { subject: LifelineErrorSubject; subjectName: string }> = [];
    for (const key of LIFELINE_ERROR_SUBJECTS) {
        if (subj && key !== subj) continue;
        const group = state.errors?.[key];
        const items = Array.isArray(group?.items) ? group!.items! : [];
        for (const it of items) {
            if (!it || typeof it.q !== "string" || !it.q) continue;
            if (status && it.status !== status) continue;
            out.push({ ...it, subject: key, subjectName: LIFELINE_ERROR_SUBJ_LABELS[key] });
        }
    }
    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1)));
    return out;
}
