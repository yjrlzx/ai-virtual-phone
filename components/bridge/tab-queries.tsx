"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import {
  CARD,
  BTN,
  BTN_GHOST,
  BTN_RED,
  INPUT,
  GUIDE_BOX,
  INK,
  SUB,
  FAINT,
  Badge,
  Switch,
  EmptyState,
  loadJson,
  saveJson,
  fmtTime,
  runShellAction,
} from "./shared";
import type { BridgeTabProps } from "./shared";

/** 主动查询 Tab：定义数据项，角色按需实时查询手机状态（电量 / 位置 / 前台 App / 设备 / 自定义 Shell）。 */

type QuerySource = "battery" | "location" | "current_app" | "device" | "shell";

type QueryItem = {
  id: string;
  /** 展示名 */
  name: string;
  /** 英文标识符，角色按此 key 取值 */
  key: string;
  source: QuerySource;
  /** 告诉角色这个数据项代表什么 */
  description: string;
  /** source=shell 时执行的命令 */
  command?: string;
  enabled: boolean;
  /** 上次查询时间 */
  updatedAt?: number;
  /** 上次查询结果文案 */
  lastValue?: string;
};

const QUERY_KEY = "huawei_query_items_v1";

const SOURCES: Array<{ value: QuerySource; label: string; hint: string }> = [
  { value: "battery", label: "电量", hint: "getStatus() 读取电量百分比" },
  { value: "location", label: "位置", hint: "getLocation() 实时经纬度" },
  { value: "current_app", label: "前台应用", hint: "getCurrentApp() 当前前台包名" },
  { value: "device", label: "设备信息", hint: "getDeviceInfo() 机型 / 存储 / 内存" },
  { value: "shell", label: "自定义 Shell", hint: "runShellCommand() 执行自定义命令" },
];

function loadItems(): QueryItem[] {
  const list = loadJson<QueryItem[]>(QUERY_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter(
    it => it && typeof it.id === "string" && typeof it.key === "string" && typeof it.name === "string",
  );
}

function sourceLabel(s: QuerySource): string {
  return SOURCES.find(x => x.value === s)?.label ?? s;
}

function gb(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `${(n / 1073741824).toFixed(1)}GB` : "未知";
}

/** 把桥返回的 JSON 外壳解析成语义化结果字符串。 */
function explainQuery(source: QuerySource, raw?: string): string {
  if (!raw) return "无返回";
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object") return String(raw);
  if (parsed.ok === false) return `失败：${String(parsed.error ?? "未知错误")}`;
  switch (source) {
    case "battery":
      return `电量 ${String(parsed.battery ?? "?")}%`;
    case "location": {
      const lat = Number(parsed.lat);
      const lng = Number(parsed.lng);
      return Number.isFinite(lat)
        ? `纬度 ${lat.toFixed(5)}，经度 ${lng.toFixed(5)}`
        : "未获取到位置";
    }
    case "current_app":
      return parsed.currentApp ? String(parsed.currentApp) : "无前台应用（或无障碍未开启）";
    case "device": {
      const parts: string[] = [];
      if (typeof parsed.model === "string" && parsed.model) parts.push(`机型 ${parsed.model}`);
      if (typeof parsed.androidVersion === "string" && parsed.androidVersion) parts.push(`Android ${parsed.androidVersion}`);
      parts.push(`存储可用 ${gb(parsed.storageFree)}`);
      parts.push(`内存可用 ${gb(parsed.ramFree)}`);
      if (typeof parsed.batteryTempC === "number") parts.push(`电池 ${Number(parsed.batteryTempC).toFixed(1)}℃`);
      return parts.join("，");
    }
    case "shell": {
      const out = String(parsed.output ?? "").trim();
      return out ? out.slice(0, 300) : `退出码 ${String(parsed.exitCode ?? "?")}，无输出`;
    }
  }
}

/** 真实调桥拉一次数据，返回解析后的文案与是否成功。 */
function runQuery(item: QueryItem): { ok: boolean; text: string } {
  let res: { ok: boolean; detail: string };
  switch (item.source) {
    case "battery":
      res = runShellAction("读取电量", s => s.getStatus?.());
      break;
    case "location":
      res = runShellAction("读取位置", s => s.getLocation?.());
      break;
    case "current_app":
      res = runShellAction("读取前台应用", s => s.getCurrentApp?.());
      break;
    case "device":
      res = runShellAction("读取设备信息", s => s.getDeviceInfo?.());
      break;
    case "shell":
      res = runShellAction("执行 Shell", s => s.runShellCommand?.(item.command ?? ""));
      break;
  }
  if (!res.ok) return { ok: false, text: res.detail };
  return { ok: res.ok, text: explainQuery(item.source, res.detail) };
}

type Draft = {
  id?: string;
  name: string;
  key: string;
  source: QuerySource;
  description: string;
  command: string;
};

const EMPTY_DRAFT: Draft = { name: "", key: "", source: "battery", description: "", command: "" };

const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 700, color: SUB, display: "block", margin: "10px 0 5px" };

export function TabQueries({ onNotice }: BridgeTabProps) {
  const [items, setItems] = useState<QueryItem[]>(() => loadItems());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [querying, setQuerying] = useState<Record<string, boolean>>({});

  const persist = (list: QueryItem[]) => {
    setItems(list);
    saveJson(QUERY_KEY, list);
  };

  const toggle = (id: string) =>
    persist(items.map(it => (it.id === id ? { ...it, enabled: !it.enabled } : it)));

  const remove = (id: string) => persist(items.filter(it => it.id !== id));

  const openEdit = (it: QueryItem) =>
    setDraft({
      id: it.id,
      name: it.name,
      key: it.key,
      source: it.source,
      description: it.description,
      command: it.command ?? "",
    });

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    const key = draft.key.trim();
    if (!name) { onNotice?.("请填写数据项名"); return; }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) { onNotice?.("key 需为英文标识符，字母/下划线开头"); return; }
    if (items.some(it => it.key === key && it.id !== draft.id)) { onNotice?.("这个 key 已被占用"); return; }
    if (draft.source === "shell" && !draft.command.trim()) { onNotice?.("自定义 Shell 需填写命令"); return; }

    const existing = draft.id ? items.find(it => it.id === draft.id) : undefined;
    const record: QueryItem = {
      id: draft.id ?? `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      key,
      source: draft.source,
      description: draft.description.trim().slice(0, 300),
      command: draft.source === "shell" ? draft.command.trim().slice(0, 2000) : undefined,
      enabled: existing ? existing.enabled : true,
      updatedAt: existing?.updatedAt,
      lastValue: existing?.lastValue,
    };
    const list = draft.id ? items.map(it => (it.id === draft.id ? record : it)) : [record, ...items];
    persist(list);
    setDraft(null);
    onNotice?.(draft.id ? "数据项已更新" : `数据项「${name}」已创建`);
  };

  const queryOnce = (it: QueryItem) => {
    setQuerying(m => ({ ...m, [it.id]: true }));
    const r = runQuery(it);
    const updated: QueryItem = { ...it, updatedAt: Date.now(), lastValue: r.text };
    persist(items.map(x => (x.id === it.id ? updated : x)));
    setQuerying(m => ({ ...m, [it.id]: false }));
    onNotice?.(`${it.name}：${r.text}`);
  };

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 新建 / 编辑向导 */}
      {draft ? (
        <div style={{ ...CARD, marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <b style={{ fontSize: 14, color: INK }}>{draft.id ? "编辑数据项" : "新建数据项"}</b>
            <button type="button" style={{ ...BTN_GHOST, padding: "4px 12px" }} onClick={() => setDraft(null)}>
              取消
            </button>
          </div>

          <label style={labelStyle}>数据项名</label>
          <input style={INPUT} placeholder="例如 手机电量" value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })} />

          <label style={labelStyle}>key（英文标识符，角色按此取值）</label>
          <input style={INPUT} placeholder="例如 battery_level" value={draft.key}
            onChange={e => setDraft({ ...draft, key: e.target.value })} />

          <label style={labelStyle}>数据源</label>
          <select style={INPUT} value={draft.source}
            onChange={e => setDraft({ ...draft, source: e.target.value as QuerySource })}>
            {SOURCES.map(s => (
              <option key={s.value} value={s.value}>{s.label} — {s.hint}</option>
            ))}
          </select>

          {draft.source === "shell" ? (
            <>
              <label style={labelStyle}>要执行的 Shell 命令</label>
              <input style={INPUT} placeholder="例如 dumpsys battery | grep level" value={draft.command}
                onChange={e => setDraft({ ...draft, command: e.target.value })} />
            </>
          ) : null}

          <label style={labelStyle}>描述（这个数据项代表什么）</label>
          <input style={INPUT} placeholder="例如 手机当前剩余电量百分比" value={draft.description}
            onChange={e => setDraft({ ...draft, description: e.target.value })} />

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button type="button" style={BTN} onClick={save}>保存数据项</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <button type="button" style={{ ...BTN, padding: "10px 22px" }} onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            + 新建数据项
          </button>
        </div>
      )}

      {/* 数据项列表 */}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {items.length === 0 && !draft ? (
          <EmptyState
            title="还没有查询数据项"
            desc="定义一组手机状态字段，角色需要时实时查安卓壳：电量、位置、前台 App、设备信息或自定义 Shell。"
            actionLabel="新建第一个数据项"
            onAction={() => setDraft({ ...EMPTY_DRAFT })}
          />
        ) : null}

        {items.map(it => (
          <div key={it.id} style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 14, color: INK }}>{it.name}</b>
                  <Badge tone="gray" text={sourceLabel(it.source)} />
                  {it.enabled ? <Badge tone="ok" text="已启用" /> : <Badge tone="gray" text="已停用" />}
                </div>
                <div style={{ fontSize: 11.5, color: FAINT, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                  key: {it.key}
                </div>
                {it.description ? (
                  <div style={{ fontSize: 12, color: SUB, marginTop: 4, lineHeight: 1.6 }}>{it.description}</div>
                ) : null}
              </div>
              <Switch on={it.enabled} onChange={() => toggle(it.id)} label={it.name} />
            </div>

            <div style={{ ...GUIDE_BOX, marginTop: 10, marginBottom: 0 }}>
              {it.lastValue ? (
                <>
                  <div style={{ color: INK, fontWeight: 700 }}>{it.lastValue}</div>
                  <div style={{ color: FAINT, marginTop: 3, fontSize: 11 }}>
                    上次查询 {it.updatedAt ? fmtTime(it.updatedAt) : "--"}
                  </div>
                </>
              ) : (
                <span style={{ color: FAINT }}>还没查过，点下面「查询一次」拉取实时值。</span>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" style={BTN} onClick={() => queryOnce(it)} disabled={querying[it.id]}>
                {querying[it.id] ? "查询中…" : "查询一次"}
              </button>
              <button type="button" style={BTN_GHOST} onClick={() => openEdit(it)}>编辑</button>
              <button type="button" style={BTN_RED} onClick={() => remove(it.id)}>删除</button>
            </div>
          </div>
        ))}
      </div>

      {items.length > 0 ? (
        <p style={{ fontSize: 11, color: FAINT, lineHeight: 1.6, marginTop: 12 }}>
          查询结果直接由安卓壳实时返回并缓存上次值，不做云端上报；角色按需主动拉取即可。
        </p>
      ) : null}
    </div>
  );
}
