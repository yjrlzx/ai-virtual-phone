"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { loadHuaweiCustomActions, saveHuaweiCustomActions, appendHuaweiBridgeEvent, interpolateHuaweiTemplate } from "@/lib/huawei-shell/storage";
import type {
  HuaweiCustomAction,
  HuaweiCustomActionType,
  HuaweiStatusKey,
  HuaweiActionParam,
  HuaweiActionResultMode,
  HuaweiActionDelivery,
} from "@/lib/huawei-shell/types";
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
  RED,
  Badge,
  Switch,
  EmptyState,
  runShellAction,
  fmtTime,
} from "./shared";
import type { BridgeTabProps } from "./shared";

/** 快捷动作 Tab：把角色工具名绑定到安卓可执行动作（打开应用 / 推送通知 / 读状态 / Shell）。 */

const ACTION_TYPES: Array<{ value: HuaweiCustomActionType; label: string; hint: string }> = [
  { value: "open_app", label: "打开应用", hint: "启动指定包名的 App" },
  { value: "send_notification", label: "推送通知", hint: "在系统通知栏发一条提醒" },
  { value: "read_status", label: "读取状态", hint: "读取电量 / 位置 / 前台应用等内置状态" },
  { value: "shell", label: "Shell 命令", hint: "通过 Shizuku 执行 adb shell 命令" },
];

const STATUS_KEYS: Array<{ value: HuaweiStatusKey; label: string }> = [
  { value: "battery", label: "电量" },
  { value: "volume", label: "媒体音量" },
  { value: "network", label: "网络连接" },
  { value: "accessibility", label: "无障碍服务" },
  { value: "floating", label: "悬浮球权限" },
  { value: "locked", label: "门禁锁数量" },
  { value: "location", label: "实时位置" },
  { value: "current_app", label: "当前前台应用" },
];

function typeLabel(t: HuaweiCustomActionType): string {
  return ACTION_TYPES.find(x => x.value === t)?.label ?? t;
}

function statusKeyLabel(k?: HuaweiStatusKey): string {
  return STATUS_KEYS.find(x => x.value === k)?.label ?? k ?? "—";
}

function actionSummary(a: HuaweiCustomAction): string {
  switch (a.type) {
    case "open_app":
      return `包名 ${a.packageName || "未填"}`;
    case "send_notification":
      return `${a.title || "无标题"} · ${a.content || "无正文"}`;
    case "read_status":
      return `读取 ${statusKeyLabel(a.statusKey)}`;
    case "shell":
      return a.command ? a.command.slice(0, 48) : "未填命令";
  }
}

/** 把桥返回的 JSON 外壳解析成给人看的一句话结果。 */
function explainResult(type: HuaweiCustomActionType, statusKey?: HuaweiStatusKey, raw?: string): string {
  if (!raw) return "无返回";
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object") return String(raw);
  if (parsed.ok === false) return `失败：${String(parsed.error ?? "未知错误")}`;
  switch (type) {
    case "open_app":
      return "已下发打开应用";
    case "send_notification":
      return "通知已推送到系统栏";
    case "shell": {
      const out = String(parsed.output ?? "").trim();
      return `退出码 ${String(parsed.exitCode ?? "?")}${out ? `：${out.slice(0, 200)}` : ""}`;
    }
    case "read_status": {
      switch (statusKey) {
        case "battery":
          return `电量 ${String(parsed.battery ?? "?")}%`;
        case "volume":
          return `媒体音量 ${String(parsed.volume ?? "?")}`;
        case "network":
          return parsed.network ? "网络已连接" : "网络未连接";
        case "accessibility":
          return parsed.accessibility ? "无障碍已开启" : "无障碍未开启";
        case "floating":
          return parsed.floating ? "悬浮球已授权" : "悬浮球未授权";
        case "locked":
          return `门禁锁 ${String(parsed.lockedApps ?? 0)} 个 App`;
        case "location": {
          const lat = Number(parsed.lat);
          const lng = Number(parsed.lng);
          return Number.isFinite(lat)
            ? `纬度 ${lat.toFixed(5)}，经度 ${lng.toFixed(5)}`
            : "未获取到位置";
        }
        case "current_app":
          return parsed.currentApp ? `前台：${String(parsed.currentApp)}` : "无前台应用";
        default:
          return String(raw);
      }
    }
  }
}

/** 真实跑一次动作，返回解析后的结果文案；values 会填进命令/标题/正文里的 {参数名} 占位。 */
function runAction(a: HuaweiCustomAction, values: Record<string, string>): { ok: boolean; text: string } {
  const pkg = interpolateHuaweiTemplate(a.packageName ?? "", values);
  const title = interpolateHuaweiTemplate(a.title ?? "", values);
  const content = interpolateHuaweiTemplate(a.content ?? "", values);
  const cmd = interpolateHuaweiTemplate(a.command ?? "", values);
  let res: { ok: boolean; detail: string };
  switch (a.type) {
    case "open_app":
      res = runShellAction("打开应用", s => s.openApp?.(pkg));
      break;
    case "send_notification":
      res = runShellAction("推送通知", s =>
        s.sendNotification?.(title, content, a.openApp || undefined));
      break;
    case "shell":
      res = runShellAction("执行 Shell", s => s.runShellCommand?.(cmd));
      break;
    case "read_status":
      res = runShellAction("读取状态", s => {
        if (a.statusKey === "location") return s.getLocation?.();
        if (a.statusKey === "current_app") return s.getCurrentApp?.();
        return s.getStatus?.();
      });
      break;
  }
  return { ok: res.ok, text: explainResult(a.type, a.statusKey, res.detail) };
}

type Draft = {
  id?: string;
  name: string;
  description: string;
  type: HuaweiCustomActionType;
  packageName: string;
  title: string;
  content: string;
  openApp: string;
  statusKey: HuaweiStatusKey;
  command: string;
  params: HuaweiActionParam[];
  resultMode: HuaweiActionResultMode;
  deliveryMode: HuaweiActionDelivery;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  description: "",
  type: "open_app",
  packageName: "",
  title: "",
  content: "",
  openApp: "",
  statusKey: "battery",
  command: "",
  params: [],
  resultMode: "none",
  deliveryMode: "notification",
};

const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 700, color: SUB, display: "block", margin: "10px 0 5px" };

export function TabShortcuts({ onNotice }: BridgeTabProps) {
  const [actions, setActions] = useState<HuaweiCustomAction[]>(() => loadHuaweiCustomActions());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string; at: number }>>({});
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({});

  const persist = (list: HuaweiCustomAction[]) => {
    setActions(list);
    saveHuaweiCustomActions(list);
  };

  const toggle = (id: string) =>
    persist(actions.map(a => (a.id === id ? { ...a, enabled: !a.enabled } : a)));

  const remove = (id: string) => persist(actions.filter(a => a.id !== id));

  const openEdit = (a: HuaweiCustomAction) =>
    setDraft({
      id: a.id,
      name: a.name,
      description: a.description,
      type: a.type,
      packageName: a.packageName ?? "",
      title: a.title ?? "",
      content: a.content ?? "",
      openApp: a.openApp ?? "",
      statusKey: a.statusKey ?? "battery",
      command: a.command ?? "",
      params: a.params ? a.params.map(p => ({ ...p })) : [],
      resultMode: a.resultMode === "text" ? "text" : "none",
      deliveryMode: a.deliveryMode === "clipboard" ? "clipboard" : "notification",
    });

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { onNotice?.("请填写工具名（角色调用时用的名字）"); return; }
    if (draft.type === "open_app" && !draft.packageName.trim()) { onNotice?.("请填写要打开的应用包名"); return; }
    if (draft.type === "send_notification" && (!draft.title.trim() || !draft.content.trim())) { onNotice?.("请填写通知标题与正文"); return; }
    if (draft.type === "shell" && !draft.command.trim()) { onNotice?.("请填写要执行的 Shell 命令"); return; }

    const existing = draft.id ? actions.find(a => a.id === draft.id) : undefined;
    // 规范化参数行：key 非空才保留，去重
    const seenKeys = new Set<string>();
    const params = draft.params
      .map(p => ({ key: p.key.trim(), type: p.type, description: p.description.trim() }))
      .filter(p => {
        if (!p.key || seenKeys.has(p.key)) return false;
        seenKeys.add(p.key);
        return true;
      })
      .slice(0, 10);

    const record: HuaweiCustomAction = {
      id: draft.id ?? `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      type: draft.type,
      description: draft.description.trim().slice(0, 300),
      packageName: draft.type === "open_app" ? draft.packageName.trim() || undefined : undefined,
      title: draft.type === "send_notification" ? draft.title.trim() : undefined,
      content: draft.type === "send_notification" ? draft.content.trim() : undefined,
      openApp: draft.type === "send_notification" && draft.openApp.trim() ? draft.openApp.trim() : undefined,
      statusKey: draft.type === "read_status" ? draft.statusKey : undefined,
      command: draft.type === "shell" ? draft.command.trim().slice(0, 2000) : undefined,
      params: params.length > 0 ? params : undefined,
      resultMode: draft.resultMode === "text" ? "text" : undefined,
      deliveryMode: draft.resultMode === "text" && draft.deliveryMode === "clipboard" ? "clipboard" : undefined,
      enabled: existing ? existing.enabled : true,
      createdAt: existing ? existing.createdAt : Date.now(),
    };
    const list = draft.id ? actions.map(a => (a.id === draft.id ? record : a)) : [record, ...actions];
    persist(list);
    setDraft(null);
    onNotice?.(draft.id ? "动作已更新" : `动作「${name}」已创建`);
  };

  const test = (a: HuaweiCustomAction) => {
    const values = paramValues[a.id] ?? {};
    const r = runAction(a, values);
    // 声明了结果回传时，按送达方式把摘要送到通知栏或剪贴板
    if (r.ok && a.resultMode === "text") {
      if (a.deliveryMode === "clipboard") {
        runShellAction("写入剪贴板", s => s.writeClipboard?.(r.text));
      } else {
        runShellAction("推送结果通知", s => s.sendNotification?.(`[结果] ${a.name}`, r.text, ""));
      }
    }
    appendHuaweiBridgeEvent({ kind: "action", title: a.name, detail: r.text, ok: r.ok });
    setTests(m => ({ ...m, [a.id]: { ok: r.ok, text: r.text, at: Date.now() } }));
    onNotice?.(`${a.name} · ${r.text}`);
  };

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 新建 / 编辑向导 */}
      {draft ? (
        <div style={{ ...CARD, marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <b style={{ fontSize: 14, color: INK }}>{draft.id ? "编辑动作" : "新建快捷动作"}</b>
            <button type="button" style={{ ...BTN_GHOST, padding: "4px 12px" }} onClick={() => setDraft(null)}>
              取消
            </button>
          </div>

          <label style={labelStyle}>工具名（角色调用时用，英文短词）</label>
          <input style={INPUT} placeholder="例如 openWeChat" value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })} />

          <label style={labelStyle}>描述（告诉角色什么时候用它）</label>
          <input style={INPUT} placeholder="例如 用户说打开微信时调用" value={draft.description}
            onChange={e => setDraft({ ...draft, description: e.target.value })} />

          <label style={labelStyle}>动作类型</label>
          <select style={INPUT} value={draft.type}
            onChange={e => setDraft({ ...draft, type: e.target.value as HuaweiCustomActionType })}>
            {ACTION_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label} — {t.hint}</option>
            ))}
          </select>

          {draft.type === "open_app" ? (
            <>
              <label style={labelStyle}>应用包名</label>
              <input style={INPUT} placeholder="例如 com.tencent.mm" value={draft.packageName}
                onChange={e => setDraft({ ...draft, packageName: e.target.value })} />
            </>
          ) : null}

          {draft.type === "send_notification" ? (
            <>
              <label style={labelStyle}>通知标题</label>
              <input style={INPUT} placeholder="例如 提醒" value={draft.title}
                onChange={e => setDraft({ ...draft, title: e.target.value })} />
              <label style={labelStyle}>通知正文</label>
              <input style={INPUT} placeholder="通知内容" value={draft.content}
                onChange={e => setDraft({ ...draft, content: e.target.value })} />
              <label style={labelStyle}>点击后打开的包名（可空）</label>
              <input style={INPUT} placeholder="例如 com.tencent.mm" value={draft.openApp}
                onChange={e => setDraft({ ...draft, openApp: e.target.value })} />
            </>
          ) : null}

          {draft.type === "read_status" ? (
            <>
              <label style={labelStyle}>读取哪个状态</label>
              <select style={INPUT} value={draft.statusKey}
                onChange={e => setDraft({ ...draft, statusKey: e.target.value as HuaweiStatusKey })}>
                {STATUS_KEYS.map(k => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </>
          ) : null}

          {draft.type === "shell" ? (
            <>
              <label style={labelStyle}>adb shell 命令（Shizuku 执行）</label>
              <input style={INPUT} placeholder="例如 dumpsys battery | grep level" value={draft.command}
                onChange={e => setDraft({ ...draft, command: e.target.value })} />
              <div style={{ fontSize: 11, color: FAINT, marginTop: 4 }}>
                命令里可写 {`{参数名}`} 占位，调用时会被替换成实际参数值。
              </div>
            </>
          ) : null}

          {/* 运行参数：命令 / 标题 / 正文里用 {key} 占位 */}
          <label style={labelStyle}>运行参数（可空）</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {draft.params.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input style={{ ...INPUT, flex: 1.2 }} placeholder="参数名 key" value={p.key}
                  onChange={e => {
                    const params = draft.params.map((x, j) => j === i ? { ...x, key: e.target.value } : x);
                    setDraft({ ...draft, params });
                  }} />
                <select style={{ ...INPUT, flex: 0.8 }} value={p.type}
                  onChange={e => {
                    const params = draft.params.map((x, j) => j === i ? { ...x, type: e.target.value as "string" | "number" } : x);
                    setDraft({ ...draft, params });
                  }}>
                  <option value="string">文本</option>
                  <option value="number">数字</option>
                </select>
                <input style={{ ...INPUT, flex: 1.4 }} placeholder="描述" value={p.description}
                  onChange={e => {
                    const params = draft.params.map((x, j) => j === i ? { ...x, description: e.target.value } : x);
                    setDraft({ ...draft, params });
                  }} />
                <button type="button" style={{ ...BTN_RED, padding: "6px 10px" }} aria-label="删除参数"
                  onClick={() => setDraft({ ...draft, params: draft.params.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button type="button" style={{ ...BTN_GHOST, marginTop: 8, padding: "6px 14px" }}
            onClick={() => setDraft({ ...draft, params: [...draft.params, { key: "", type: "string", description: "" }] })}>
            ＋ 添加参数
          </button>

          {/* 结果回传 */}
          <label style={labelStyle}>返回模式</label>
          <select style={INPUT} value={draft.resultMode}
            onChange={e => setDraft({ ...draft, resultMode: e.target.value as HuaweiActionResultMode })}>
            <option value="none">不等待结果</option>
            <option value="text">执行后回传文本结果</option>
          </select>
          <label style={labelStyle}>结果送达方式</label>
          <select style={{ ...INPUT, opacity: draft.resultMode === "text" ? 1 : 0.5 }}
            disabled={draft.resultMode !== "text"}
            value={draft.deliveryMode}
            onChange={e => setDraft({ ...draft, deliveryMode: e.target.value as HuaweiActionDelivery })}>
            <option value="notification">系统通知栏</option>
            <option value="clipboard">写入剪贴板</option>
          </select>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button type="button" style={BTN} onClick={save}>保存动作</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <button type="button" style={{ ...BTN, padding: "10px 22px" }} onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            + 新建快捷动作
          </button>
        </div>
      )}

      {/* 动作列表 */}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {actions.length === 0 && !draft ? (
          <EmptyState
            title="还没有快捷动作"
            desc="把一个安卓动作绑成角色可调用的工具：打开 App、推送提醒、读状态、跑 Shell 命令。"
            actionLabel="新建第一个动作"
            onAction={() => setDraft({ ...EMPTY_DRAFT })}
          />
        ) : null}

        {actions.map(a => {
          const t = tests[a.id];
          return (
            <div key={a.id} style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <b style={{ fontSize: 14, color: INK }}>{a.name}</b>
                    <Badge tone="gray" text={typeLabel(a.type)} />
                    {a.enabled ? <Badge tone="ok" text="已启用" /> : <Badge tone="gray" text="已停用" />}
                  </div>
                  <div style={{ fontSize: 11.5, color: FAINT, marginTop: 4, lineHeight: 1.5 }}>{actionSummary(a)}</div>
                  {a.params && a.params.length > 0 ? (
                    <div style={{ fontSize: 11, color: FAINT, marginTop: 4 }}>
                      参数：{a.params.map(p => `${p.key}:${p.type === "number" ? "数字" : "文本"}`).join("，")}
                      {a.resultMode === "text" ? ` · 结果回传（${a.deliveryMode === "clipboard" ? "剪贴板" : "通知栏"}）` : ""}
                    </div>
                  ) : null}
                  {a.description ? (
                    <div style={{ fontSize: 12, color: SUB, marginTop: 4, lineHeight: 1.6 }}>{a.description}</div>
                  ) : null}
                </div>
                <Switch on={a.enabled} onChange={() => toggle(a.id)} label={a.name} />
              </div>

              {t ? (
                <div style={{ ...GUIDE_BOX, marginTop: 10, marginBottom: 0, color: t.ok ? SUB : RED }}>
                  {t.text}
                  <span style={{ float: "right", color: FAINT }}>{fmtTime(t.at)}</span>
                </div>
              ) : null}

              {a.params && a.params.length > 0 ? (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {a.params.map(p => (
                    <div key={p.key} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 11.5, color: SUB, width: 84, flexShrink: 0 }}>{p.key}</span>
                      <input
                        style={{ ...INPUT, padding: "7px 10px" }}
                        type={p.type === "number" ? "number" : "text"}
                        placeholder={p.description || p.key}
                        value={(paramValues[a.id] ?? {})[p.key] ?? ""}
                        onChange={e => setParamValues(m => ({
                          ...m,
                          [a.id]: { ...(m[a.id] ?? {}), [p.key]: e.target.value },
                        }))}
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" style={BTN} onClick={() => test(a)}>试运行</button>
                <button type="button" style={BTN_GHOST} onClick={() => openEdit(a)}>编辑</button>
                <button type="button" style={BTN_RED} onClick={() => remove(a.id)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {actions.length > 0 ? (
        <p style={{ fontSize: 11, color: FAINT, lineHeight: 1.6, marginTop: 12 }}>
          试运行会真实调用一次安卓桥（打开 App / 发通知 / 读状态 / 跑 Shell）。启用后角色即可按描述调用。
        </p>
      ) : null}
    </div>
  );
}
