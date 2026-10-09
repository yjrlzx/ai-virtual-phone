"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  ACCENT, CARD, BTN, BTN_GHOST, BTN_RED, INPUT, GUIDE_BOX,
  Badge, Switch, EmptyState, fmtTime, runShellAction,
  SUB, INK, FAINT,
} from "./shared";
import type { BridgeTabProps } from "./shared";
import {
  loadHuaweiTriggerRules, saveHuaweiTriggerRules,
  loadHuaweiCustomActions, getAndroidShell, appendHuaweiBridgeEvent,
} from "@/lib/huawei-shell/storage";
import { ALIPAY_PACKAGE, WECHAT_PACKAGE } from "@/lib/huawei-shell/types";
import type {
  HuaweiTriggerRule, HuaweiTriggerRuleAction, HuaweiTriggerRuleTrigger,
  HuaweiChatRole, HuaweiMemoryScope, HuaweiCalendarDirection,
} from "@/lib/huawei-shell/types";
import { loadCharacters } from "@/lib/character-storage";
import { loadBridgeShortcutActions } from "@/lib/reality-bridge/storage";

/**
 * 自动联动 Tab：联动规则列表 + 6 步新建/编辑向导。
 * 规则数据全部来自 loadHuaweiTriggerRules()（云端 kv，手机/网页共享），
 * 动作集与 iOS 现实桥对齐：chat/memory/timeline/calendar/card/shortcut。
 */

const WIZ_STEP_NAMES = ["接通管道", "选择动作", "选择信号", "加工内容", "动作参数", "测试与保存"] as const;

const WEEKDAYS = [
  { key: "sun", label: "日" }, { key: "mon", label: "一" }, { key: "tue", label: "二" },
  { key: "wed", label: "三" }, { key: "thu", label: "四" }, { key: "fri", label: "五" },
  { key: "sat", label: "六" },
] as const;

/** Shizuku 应用包名（与 ShizukuAuthorizer.kt 一致），用于「打开 Shizuku」 */
const SHIZUKU_PACKAGE = "moe.shizuku.privileged.api";

/** 通知触发的快捷来源包名 */
const QUICK_PKGS = [
  { pkg: WECHAT_PACKAGE, label: "微信" },
  { pkg: ALIPAY_PACKAGE, label: "支付宝" },
  { pkg: "payment", label: "支付到账" },
] as const;

/** 动作类型选项（与 HuaweiTriggerRuleAction 对齐） */
const ACTION_OPTIONS: Array<{ v: HuaweiTriggerRuleAction; t: string; d: string }> = [
  { v: "send_notification", t: "发通知", d: "在手机通知栏弹一条提醒" },
  { v: "open_app", t: "打开应用", d: "自动跳到指定 App" },
  { v: "custom_action", t: "自定义动作", d: "调用你登记过的动作" },
  { v: "chat", t: "写进聊天", d: "把信号写进与某角色的对话，可选让 TA 回复" },
  { v: "memory", t: "写入记忆", d: "存进角色长期/核心记忆" },
  { v: "timeline", t: "写入时间线", d: "记到角色的时间线里" },
  { v: "calendar", t: "写入日历", d: "在今天用户日历里加一条" },
  { v: "card", t: "发送卡片", d: "以卡片形式发进聊天" },
  { v: "shortcut", t: "快捷动作", d: "执行已配置的现实桥快捷指令" },
];

const chipBase: CSSProperties = {
  border: "none",
  borderRadius: 999,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const fieldLabel: CSSProperties = { fontSize: 12, fontWeight: 700, color: SUB, display: "block", margin: "12px 0 6px" };

/* ---------------- 草稿（向导编辑中的规则） ---------------- */

type Draft = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: HuaweiTriggerRuleTrigger;
  notifyPkg: string;
  notifyKeyword: string;
  time: string;
  days: string[];
  action: HuaweiTriggerRuleAction;
  title: string;
  content: string;
  openApp: string;
  actionPackageName: string;
  actionName: string;
  processMode: "raw" | "template" | "ai";
  contentTemplate: string;
  aiPrompt: string;
  /* chat */
  chatCharacterId: string;
  chatRole: HuaweiChatRole;
  chatRequestReply: boolean;
  /* memory */
  memoryCharacterId: string;
  memoryScope: HuaweiMemoryScope;
  /* timeline */
  timelineCharacterId: string;
  /* calendar */
  calendarStartTime: string;
  calendarEndTime: string;
  calendarDirection: "" | HuaweiCalendarDirection;
  calendarDurationMinutes: string;
  /* card */
  cardCharacterId: string;
  /* shortcut */
  shortcutActionId: string;
};

function blankDraft(): Draft {
  return {
    id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    enabled: true,
    trigger: "notification",
    notifyPkg: "",
    notifyKeyword: "",
    time: "08:00",
    days: [],
    action: "send_notification",
    title: "",
    content: "",
    openApp: "",
    actionPackageName: "",
    actionName: "",
    processMode: "raw",
    contentTemplate: "",
    aiPrompt: "",
    chatCharacterId: "",
    chatRole: "user",
    chatRequestReply: false,
    memoryCharacterId: "",
    memoryScope: "long_term",
    timelineCharacterId: "",
    calendarStartTime: "09:00",
    calendarEndTime: "10:00",
    calendarDirection: "",
    calendarDurationMinutes: "30",
    cardCharacterId: "",
    shortcutActionId: "",
  };
}

function draftFromRule(r: HuaweiTriggerRule): Draft {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger,
    notifyPkg: r.notifyPkg ?? "",
    notifyKeyword: r.notifyKeyword ?? "",
    time: r.time ?? "08:00",
    days: Array.isArray(r.days) ? [...r.days] : [],
    action: r.action,
    title: r.title ?? "",
    content: r.content ?? "",
    openApp: r.openApp ?? "",
    actionPackageName: r.actionPackageName ?? "",
    actionName: r.actionName ?? "",
    processMode: r.processMode === "template" ? "template" : r.processMode === "ai" ? "ai" : "raw",
    contentTemplate: r.contentTemplate ?? "",
    aiPrompt: r.aiPrompt ?? "",
    chatCharacterId: r.chatCharacterId ?? "",
    chatRole: r.chatRole ?? "user",
    chatRequestReply: r.chatRequestReply === true,
    memoryCharacterId: r.memoryCharacterId ?? "",
    memoryScope: r.memoryScope === "core" ? "core" : "long_term",
    timelineCharacterId: r.timelineCharacterId ?? "",
    calendarStartTime: r.calendarStartTime ?? "09:00",
    calendarEndTime: r.calendarEndTime ?? "10:00",
    calendarDirection: r.calendarDirection ?? "",
    calendarDurationMinutes: String(r.calendarDurationMinutes ?? 30),
    cardCharacterId: r.cardCharacterId ?? "",
    shortcutActionId: r.shortcutActionId ?? "",
  };
}

function actionLabel(a: HuaweiTriggerRuleAction): string {
  return ACTION_OPTIONS.find(o => o.v === a)?.t ?? a;
}

/** 一行摘要：触发条件 → 动作 */
function summarize(r: HuaweiTriggerRule): string {
  const trig = r.trigger === "time"
    ? `定时 ${r.time || "--:--"}${r.days && r.days.length > 0
      ? `（${r.days.map(d => WEEKDAYS.find(w => w.key === d)?.label ?? d).join("/")}）`
      : "（每天）"}`
    : `通知来自 ${r.notifyPkg || "任意来源"}${r.notifyKeyword ? `，含「${r.notifyKeyword}」` : ""}`;
  let act: string;
  switch (r.action) {
    case "send_notification": act = `发通知「${r.title || ""}」`; break;
    case "open_app": act = `打开应用 ${r.actionPackageName || ""}`; break;
    case "custom_action": act = `调用自定义动作 ${r.actionName || ""}`; break;
    case "chat": act = `写进聊天（${r.chatCharacterId || "?"}${r.chatRequestReply ? "，请求回复" : ""}）`; break;
    case "memory": act = `写入记忆（${r.memoryCharacterId || "?"}/${r.memoryScope === "core" ? "核心" : "长期"}）`; break;
    case "timeline": act = `写入时间线（${r.timelineCharacterId || "?"}）`; break;
    case "calendar": act = `写入日历（${r.calendarDirection === "past" ? `过去${r.calendarDurationMinutes ?? 30}分` : r.calendarDirection === "future" ? `未来${r.calendarDurationMinutes ?? 30}分` : `${r.calendarStartTime ?? ""}-${r.calendarEndTime ?? ""}`}）`; break;
    case "card": act = `发送卡片（${r.cardCharacterId || "?"}）`; break;
    case "shortcut": act = `快捷动作 ${r.shortcutActionId || "?"}`; break;
    default: act = r.action;
  }
  return `${trig} → ${act}`;
}

/* ---------------- 第 1 步：管道就绪状态 ---------------- */

type PipeStatus = {
  accessibility: boolean;
  notificationListener: boolean;
  shizukuInstalled: boolean;
  shizukuRunning: boolean;
  shizukuPermission: boolean;
};

function readPipeStatus(): PipeStatus | null {
  const shell = getAndroidShell();
  if (!shell || typeof shell.getPermissionStatus !== "function") return null;
  try {
    const s = JSON.parse(shell.getPermissionStatus("")) as {
      accessibility?: boolean;
      notificationListener?: boolean;
      debugger?: { shizukuInstalled?: boolean; shizukuRunning?: boolean; shizukuPermission?: boolean };
    };
    return {
      accessibility: s.accessibility === true,
      notificationListener: s.notificationListener === true,
      shizukuInstalled: s.debugger?.shizukuInstalled === true,
      shizukuRunning: s.debugger?.shizukuRunning === true,
      shizukuPermission: s.debugger?.shizukuPermission === true,
    };
  } catch {
    return null;
  }
}

/* ---------------- 角色选择器 ---------------- */

function CharacterSelect({ value, onChange, placeholder }: { value: string; onChange: (id: string) => void; placeholder?: string }) {
  const chars = loadCharacters();
  return (
    <select style={INPUT} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder || "选择角色…"}</option>
      {chars.map(c => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}

/* ---------------- 向导主体 ---------------- */

function RuleWizard({
  initial,
  isExisting,
  onClose,
  onSave,
  onNotice,
}: {
  initial: Draft;
  isExisting: boolean;
  onClose: () => void;
  onSave: (d: Draft) => void;
  onNotice?: (text: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [step, setStep] = useState(1);
  const [pipe, setPipe] = useState<PipeStatus | null>(() => readPipeStatus());
  const [testResult, setTestResult] = useState<string | null>(null);
  const [recentNotifs, setRecentNotifs] = useState<Array<{ pkg: string; title: string; text: string; avatar: string }> | null>(null);

  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));

  const refreshPipe = () => setPipe(readPipeStatus());

  useEffect(() => {
    refreshPipe();
  }, []);

  const customActions = loadHuaweiCustomActions();
  const shortcutActions = loadBridgeShortcutActions();
  /** 网页侧动作（写云端共享存储，不需要安卓壳） */
  const isWebAction = ["chat", "memory", "timeline", "calendar", "card", "shortcut"].includes(draft.action);

  /* 各步必填校验；返回 null 表示可下一步 */
  function blocker(): string | null {
    if (step === 2 && !draft.action) return "请选择一个动作类型";
    if (step === 3 && draft.trigger === "time" && !/^\d{2}:\d{2}$/.test(draft.time.trim())) {
      return "请设置正确的触发时间（HH:MM）";
    }
    if (step === 4 && draft.processMode === "ai" && !draft.aiPrompt.trim()) {
      return "ai 加工需要填写提示词";
    }
    if (step === 5) {
      if (draft.action === "send_notification" && (!draft.title.trim() || !draft.content.trim())) {
        return "发通知需要填写标题和正文";
      }
      if (draft.action === "open_app" && !draft.actionPackageName.trim()) return "请填写要打开的应用包名";
      if (draft.action === "custom_action" && !draft.actionName.trim()) return "请选择一个已登记的自定义动作";
      if (draft.action === "chat" && !draft.chatCharacterId) return "请选择要写入的角色";
      if (draft.action === "memory" && !draft.memoryCharacterId) return "请选择要写入记忆的角色";
      if (draft.action === "timeline" && !draft.timelineCharacterId) return "请选择要写入时间线的角色";
      if (draft.action === "card" && !draft.cardCharacterId) return "请选择要发送卡片的角色";
      if (draft.action === "shortcut" && !draft.shortcutActionId) return "请选择一个已配置的快捷动作";
      if (draft.action === "calendar" && !draft.calendarDirection && (!draft.calendarStartTime || !draft.calendarEndTime)) {
        return "日历请选择铺时段方向或填写固定起止时间";
      }
    }
    return null;
  }

  function next() {
    const b = blocker();
    if (b) { onNotice?.(b); return; }
    if (step >= WIZ_STEP_NAMES.length) { onSave(draft); return; }
    setStep(s => s + 1);
  }

  function runTest() {
    setTestResult(null);
    let res: { ok: boolean; detail: string };
    if (draft.action === "send_notification") {
      res = runShellAction("发送测试通知", s =>
        s.sendNotification?.(`[测试] ${draft.title.trim() || "联动"}`, draft.content.trim() || "测试内容", draft.openApp.trim()));
    } else if (draft.action === "open_app") {
      res = runShellAction("测试打开应用", s => s.openApp?.(draft.actionPackageName.trim()));
    } else if (isWebAction) {
      res = { ok: true, detail: `保存后，触发时将执行「${actionLabel(draft.action)}」（网页侧动作，无需在手机上测试）` };
    } else {
      res = { ok: true, detail: `保存后将调用已登记动作「${draft.actionName.trim() || "未选择"}」` };
    }
    setTestResult(`${res.ok ? "✓ " : "✗ "}${res.detail}`);
    appendHuaweiBridgeEvent({
      kind: "action",
      title: `测试联动 · ${draft.name.trim() || "未命名"}`,
      detail: res.detail,
      ok: res.ok,
    });
    onNotice?.(res.ok ? "测试已执行" : `测试失败：${res.detail}`);
    // 通知类规则：拉最近通知预览，帮助确认信号能命中
    if (draft.trigger === "notification") {
      const shell = getAndroidShell();
      if (shell && typeof shell.getNotifications === "function") {
        try {
          const arr = JSON.parse(shell.getNotifications(6)) as Array<Record<string, unknown>>;
          setRecentNotifs(arr.map(n => ({
            pkg: String(n.pkg ?? ""),
            title: String(n.title ?? ""),
            text: String(n.text ?? ""),
            avatar: typeof n.avatar === "string" ? n.avatar : "",
          })));
        } catch {
          setRecentNotifs([]);
        }
      }
    }
  }

  const shizukuReady = pipe?.shizukuInstalled && pipe.shizukuRunning && pipe.shizukuPermission;

  return (
    <div style={{ ...CARD, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <b style={{ fontSize: 14, color: INK }}>{isExisting ? "编辑联动" : "新建联动"}</b>
        <button type="button" onClick={onClose} style={{ ...BTN_GHOST, padding: "4px 12px" }}>关闭</button>
      </div>

      {/* 步骤条 */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {WIZ_STEP_NAMES.map((s, i) => (
          <div key={s} style={{ flex: 1, textAlign: "center" }}>
            <div style={{ height: 4, borderRadius: 2, background: i < step ? ACCENT : "rgba(150,190,230,.25)", marginBottom: 5 }} />
            <div style={{ fontSize: 10, color: i + 1 === step ? INK : FAINT, fontWeight: i + 1 === step ? 700 : 500 }}>
              {i + 1}. {s}
            </div>
          </div>
        ))}
      </div>

      {/* ---------- 第 1 步 接通管道 ---------- */}
      {step === 1 ? (
        <div>
          <p style={{ fontSize: 12, color: SUB, lineHeight: 1.7, margin: "0 0 8px" }}>
            联动靠两条管道工作：无障碍服务负责读取屏幕状态，Shizuku（免 Root）负责执行动作。请确认二者就绪。
          </p>
          <PipeRow label="无障碍服务" ok={pipe?.accessibility ?? false}
            okText="已开启" badText="未开启" />
          <PipeRow label="通知监听" ok={pipe?.notificationListener ?? false}
            okText="已开启" badText="未开启" />
          <PipeRow label="Shizuku" ok={shizukuReady ?? false}
            okText="已安装·运行·授权" badText={pipe ? describeShizuku(pipe) : "未检测到"} />
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button type="button" style={BTN}
              onClick={() => {
                const r = runShellAction("打开无障碍设置", s => s.openPermissionSettings?.("accessibility"));
                onNotice?.(r.ok ? "请在系统设置中开启无障碍" : r.detail);
              }}>
              开启无障碍设置
            </button>
            <button type="button" style={BTN_GHOST}
              onClick={() => {
                const r = runShellAction("打开 Shizuku", s => s.openApp?.(SHIZUKU_PACKAGE));
                onNotice?.(r.ok ? "已打开 Shizuku，请在其中授权" : r.detail);
              }}>
              打开 Shizuku
            </button>
            <button type="button" style={BTN_GHOST} onClick={refreshPipe}>刷新状态</button>
          </div>
          <div style={GUIDE_BOX}>
            提示：通知类规则需要「通知监听」权限；定时类规则无需 Shizuku 也能按点触发。写聊天/记忆/日历等网页侧动作直接落云端，手机网页两端共享。
          </div>
        </div>
      ) : null}

      {/* ---------- 第 2 步 选择动作 ---------- */}
      {step === 2 ? (
        <div>
          <p style={{ fontSize: 12, color: SUB, lineHeight: 1.7, margin: "0 0 8px" }}>
            这条联动触发后要做什么？选一个动作类型，下一步再填信号与参数。
          </p>
          {ACTION_OPTIONS.map(opt => {
            const on = draft.action === opt.v;
            return (
              <button key={opt.v} type="button" onClick={() => set({ action: opt.v })}
                style={{
                  ...chipBase, display: "block", width: "100%", textAlign: "left",
                  padding: "11px 12px", marginTop: 8, borderRadius: 12,
                  background: on ? ACCENT : "rgba(150,190,230,.12)",
                  color: on ? "#fff" : INK,
                }}>
                <b style={{ fontSize: 13 }}>{opt.t}</b>
                <span style={{ display: "block", fontSize: 11, marginTop: 2, color: on ? "rgba(255,255,255,.85)" : FAINT }}>{opt.d}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* ---------- 第 3 步 选择信号 ---------- */}
      {step === 3 ? (
        <div>
          <div style={{ display: "flex", gap: 8 }}>
            {([
              { v: "notification", t: "通知触发" },
              { v: "time", t: "定时触发" },
            ] as Array<{ v: HuaweiTriggerRuleTrigger; t: string }>).map(opt => {
              const on = draft.trigger === opt.v;
              return (
                <button key={opt.v} type="button" onClick={() => set({ trigger: opt.v })}
                  style={{ ...chipBase, background: on ? ACCENT : "rgba(150,190,230,.15)", color: on ? "#fff" : SUB }}>
                  {opt.t}
                </button>
              );
            })}
          </div>

          {draft.trigger === "notification" ? (
            <div>
              <label style={fieldLabel}>来源包名（留空 = 任意来源）</label>
              <input style={INPUT} value={draft.notifyPkg} placeholder="如 com.tencent.mm"
                onChange={e => set({ notifyPkg: e.target.value })} />
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {QUICK_PKGS.map(q => (
                  <button key={q.pkg} type="button"
                    onClick={() => set({ notifyPkg: draft.notifyPkg === q.pkg ? "" : q.pkg })}
                    style={{ ...chipBase, background: draft.notifyPkg === q.pkg ? ACCENT : "rgba(150,190,230,.15)", color: draft.notifyPkg === q.pkg ? "#fff" : SUB }}>
                    {q.label}
                  </button>
                ))}
                <button type="button" onClick={() => set({ notifyPkg: "" })}
                  style={{ ...chipBase, background: draft.notifyPkg === "" ? ACCENT : "rgba(150,190,230,.15)", color: draft.notifyPkg === "" ? "#fff" : SUB }}>
                  任意
                </button>
              </div>
              <label style={fieldLabel}>通知关键词（可空，命中标题或正文）</label>
              <input style={INPUT} value={draft.notifyKeyword} placeholder="如 支付成功"
                onChange={e => set({ notifyKeyword: e.target.value })} />
            </div>
          ) : (
            <div>
              <label style={fieldLabel}>触发时间</label>
              <input style={{ ...INPUT, maxWidth: 160 }} value={draft.time} placeholder="HH:MM"
                onChange={e => set({ time: e.target.value })} />
              <label style={fieldLabel}>星期（不选 = 每天）</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {WEEKDAYS.map(w => {
                  const on = draft.days.includes(w.key);
                  return (
                    <button key={w.key} type="button"
                      onClick={() => set({ days: on ? draft.days.filter(d => d !== w.key) : [...draft.days, w.key] })}
                      style={{ ...chipBase, background: on ? ACCENT : "rgba(150,190,230,.15)", color: on ? "#fff" : SUB }}>
                      {w.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* ---------- 第 4 步 加工内容 ---------- */}
      {step === 4 ? (
        <div>
          <p style={{ fontSize: 12, color: SUB, lineHeight: 1.7, margin: "0 0 8px" }}>
            命中信号后，怎么组织要发出去/写出去的内容？
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            {([
              { v: "raw" as const, t: "原样/固定文案" },
              { v: "template" as const, t: "模板加工" },
              { v: "ai" as const, t: "AI 加工" },
            ]).map(opt => {
              const on = draft.processMode === opt.v;
              return (
                <button key={opt.v} type="button" onClick={() => set({ processMode: opt.v })}
                  style={{ ...chipBase, background: on ? ACCENT : "rgba(150,190,230,.15)", color: on ? "#fff" : SUB }}>
                  {opt.t}
                </button>
              );
            })}
          </div>
          {draft.processMode === "template" ? (
            <>
              <label style={fieldLabel}>正文模板</label>
              <textarea
                style={{ ...INPUT, minHeight: 84, resize: "vertical", fontFamily: "inherit" }}
                placeholder="如 到账提醒：{payload}"
                value={draft.contentTemplate}
                onChange={e => set({ contentTemplate: e.target.value })}
              />
              <div style={GUIDE_BOX}>
                {`{payload} 替换成命中通知的标题与正文`}；{`{title}`} 仅标题、{`{text}`} 仅正文。定时触发没有通知内容，占位替换为空。
              </div>
            </>
          ) : null}
          {draft.processMode === "ai" ? (
            <>
              <label style={fieldLabel}>加工提示词（{`{payload}`}/{`{title}`}/{`{text}`} 占位先替换）</label>
              <textarea
                style={{ ...INPUT, minHeight: 96, resize: "vertical", fontFamily: "inherit" }}
                placeholder="如 把下面的支付通知改写成一句关心我的话，口语化，不超过 30 字："
                value={draft.aiPrompt}
                onChange={e => set({ aiPrompt: e.target.value })}
              />
              <div style={GUIDE_BOX}>
                用配置好的辅助 API（记忆总结同一通道）跑一次 LLM，只输出加工结果。通知原文会附在提示词后交给模型。
              </div>
            </>
          ) : null}
          {draft.processMode === "raw" ? (
            <div style={GUIDE_BOX}>
              通知触发：直接把通知原文写出去/发出去；定时触发或原文为空时，用下一步填的固定文案。
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---------- 第 5 步 动作参数 ---------- */}
      {step === 5 ? (
        <div>
          {draft.action === "send_notification" ? (
            <>
              <label style={fieldLabel}>通知标题</label>
              <input style={INPUT} value={draft.title} onChange={e => set({ title: e.target.value })} placeholder="如 该喝水了" />
              <label style={fieldLabel}>通知正文{draft.processMode === "template" ? "（兜底固定文案，模板未命中占位时使用）" : ""}</label>
              <input style={INPUT} value={draft.content} onChange={e => set({ content: e.target.value })} placeholder="如 定时提醒" />
              <label style={fieldLabel}>点击通知打开的包名（可空）</label>
              <input style={INPUT} value={draft.openApp} onChange={e => set({ openApp: e.target.value })} placeholder="如 com.tencent.mm" />
            </>
          ) : null}

          {draft.action === "open_app" ? (
            <>
              <label style={fieldLabel}>要打开的应用包名</label>
              <input style={INPUT} value={draft.actionPackageName} onChange={e => set({ actionPackageName: e.target.value })}
                placeholder="如 com.tencent.mm" />
            </>
          ) : null}

          {draft.action === "custom_action" ? (
            <>
              <label style={fieldLabel}>选择已登记的自定义动作</label>
              {customActions.length === 0 ? (
                <div style={GUIDE_BOX}>还没有已登记的自定义动作，可先去「快捷动作」Tab 登记，或改用发通知 / 打开应用。</div>
              ) : (
                <select style={INPUT} value={draft.actionName} onChange={e => set({ actionName: e.target.value })}>
                  <option value="">请选择…</option>
                  {customActions.filter(a => a.enabled).map(a => (
                    <option key={a.id} value={a.name}>{a.name}（{a.type}）</option>
                  ))}
                </select>
              )}
            </>
          ) : null}

          {/* 网页侧动作共享：固定/兜底文案（shortcut/calendar 不需要） */}
          {isWebAction && draft.action !== "shortcut" && draft.action !== "calendar" ? (
            <>
              <label style={fieldLabel}>固定文案（定时触发 / 通知原文为空时使用，可空）</label>
              <input style={INPUT} value={draft.content} onChange={e => set({ content: e.target.value })}
                placeholder="如 该睡觉了，放下手机吧" />
            </>
          ) : null}

          {draft.action === "chat" ? (
            <>
              <label style={fieldLabel}>写入哪个角色的聊天</label>
              <CharacterSelect value={draft.chatCharacterId} onChange={id => set({ chatCharacterId: id })} />
              <label style={fieldLabel}>消息显示身份</label>
              <select style={INPUT} value={draft.chatRole} onChange={e => set({ chatRole: e.target.value as HuaweiChatRole })}>
                <option value="user">我（用户）说</option>
                <option value="assistant">角色说</option>
                <option value="system">旁白 / 系统</option>
              </select>
              <label style={{ ...fieldLabel, display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={draft.chatRequestReply}
                  onChange={e => set({ chatRequestReply: e.target.checked })} />
                写进聊天后请求角色回应（身份为「角色说」时不触发）
              </label>
            </>
          ) : null}

          {draft.action === "memory" ? (
            <>
              <label style={fieldLabel}>写入哪个角色的记忆</label>
              <CharacterSelect value={draft.memoryCharacterId} onChange={id => set({ memoryCharacterId: id })} />
              <label style={fieldLabel}>记忆分区</label>
              <select style={INPUT} value={draft.memoryScope} onChange={e => set({ memoryScope: e.target.value as HuaweiMemoryScope })}>
                <option value="long_term">长期记忆</option>
                <option value="core">核心记忆</option>
              </select>
            </>
          ) : null}

          {draft.action === "timeline" ? (
            <>
              <label style={fieldLabel}>写入哪个角色的时间线</label>
              <CharacterSelect value={draft.timelineCharacterId} onChange={id => set({ timelineCharacterId: id })} />
            </>
          ) : null}

          {draft.action === "card" ? (
            <>
              <label style={fieldLabel}>以卡片发给哪个角色</label>
              <CharacterSelect value={draft.cardCharacterId} onChange={id => set({ cardCharacterId: id })} />
            </>
          ) : null}

          {draft.action === "calendar" ? (
            <>
              <label style={fieldLabel}>铺时段方式</label>
              <select style={INPUT} value={draft.calendarDirection}
                onChange={e => set({ calendarDirection: e.target.value as "" | HuaweiCalendarDirection })}>
                <option value="">固定起止时间</option>
                <option value="past">向前铺（记录刚过去的这段时间）</option>
                <option value="future">向后铺（记录接下来的这段时间）</option>
              </select>
              {draft.calendarDirection ? (
                <>
                  <label style={fieldLabel}>时长（分钟）</label>
                  <input style={{ ...INPUT, maxWidth: 160 }} value={draft.calendarDurationMinutes}
                    onChange={e => set({ calendarDurationMinutes: e.target.value.replace(/[^\d]/g, "") })} placeholder="如 30" />
                </>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={fieldLabel}>开始时间</label>
                    <input style={INPUT} value={draft.calendarStartTime} onChange={e => set({ calendarStartTime: e.target.value })} placeholder="HH:MM" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={fieldLabel}>结束时间</label>
                    <input style={INPUT} value={draft.calendarEndTime} onChange={e => set({ calendarEndTime: e.target.value })} placeholder="HH:MM" />
                  </div>
                </div>
              )}
              <div style={GUIDE_BOX}>日历条目写在今天，标题=加工后的内容。</div>
            </>
          ) : null}

          {draft.action === "shortcut" ? (
            <>
              <label style={fieldLabel}>选择已配置的现实桥快捷动作</label>
              {shortcutActions.length === 0 ? (
                <div style={GUIDE_BOX}>还没有已配置的快捷动作，可先在现实桥「快捷动作」里登记一个。</div>
              ) : (
                <select style={INPUT} value={draft.shortcutActionId} onChange={e => set({ shortcutActionId: e.target.value })}>
                  <option value="">请选择…</option>
                  {shortcutActions.filter(a => a.enabled).map(a => (
                    <option key={a.id} value={a.id}>{a.name}（{a.shortcutName}）</option>
                  ))}
                </select>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {/* ---------- 第 6 步 测试与保存 ---------- */}
      {step === 6 ? (
        <div>
          <div style={{ ...CARD, boxShadow: "none", background: "rgba(106,176,243,.08)", padding: "10px 12px" }}>
            <b style={{ fontSize: 13, color: INK }}>{draft.name.trim() || "未命名联动"}</b>
            <div style={{ fontSize: 12, color: SUB, marginTop: 4, lineHeight: 1.6 }}>{summarize(buildSummaryRule(draft))}</div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" style={BTN} onClick={runTest}>立即测试</button>
            <button type="button" style={BTN_GHOST} onClick={refreshPipe}>刷新状态</button>
          </div>
          {testResult ? (
            <div style={{ ...GUIDE_BOX, marginTop: 10, background: testResult.startsWith("✓") ? "rgba(47,164,106,.1)" : "rgba(217,83,79,.1)" }}>
              {testResult}
            </div>
          ) : null}

          {draft.trigger === "notification" && recentNotifs ? (
            <div style={{ marginTop: 12 }}>
              <label style={{ ...fieldLabel, marginTop: 0 }}>最近通知预览（看信号能否命中）</label>
              {recentNotifs.length === 0 ? <div style={{ fontSize: 11.5, color: FAINT }}>暂无可读通知。</div> :
                recentNotifs.map((n, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: SUB, padding: "5px 0", borderBottom: "1px solid rgba(150,190,230,.15)" }}>
                    {n.avatar ? (
                      <img
                        src={n.avatar}
                        alt=""
                        style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", flex: "0 0 auto" }}
                      />
                    ) : null}
                    <Badge tone="gray" text={n.pkg || "未知"} />
                    <span style={{ marginLeft: 6, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title || n.text}</span>
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 底部：上一步 / 下一步·保存 */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        {step > 1 ? (
          <button type="button" style={BTN_GHOST} onClick={() => setStep(s => s - 1)}>上一步</button>
        ) : null}
        <button type="button" style={BTN} onClick={next}>{step >= WIZ_STEP_NAMES.length ? "保存联动" : "下一步"}</button>
      </div>
    </div>
  );
}

/** 把草稿拼成 summarize 需要的最小形状（避免手写一长串字段） */
function buildSummaryRule(d: Draft): HuaweiTriggerRule {
  return {
    id: d.id, name: d.name, enabled: d.enabled, trigger: d.trigger,
    notifyPkg: d.notifyPkg || undefined, notifyKeyword: d.notifyKeyword || undefined,
    time: d.time || undefined, days: d.days, action: d.action,
    title: d.title || undefined, content: d.content || undefined, openApp: d.openApp || undefined,
    actionPackageName: d.actionPackageName || undefined, actionName: d.actionName || undefined,
    processMode: d.processMode === "raw" ? undefined : d.processMode,
    contentTemplate: d.contentTemplate || undefined, aiPrompt: d.aiPrompt || undefined,
    chatCharacterId: d.chatCharacterId || undefined, chatRole: d.chatRole, chatRequestReply: d.chatRequestReply || undefined,
    memoryCharacterId: d.memoryCharacterId || undefined, memoryScope: d.memoryScope,
    timelineCharacterId: d.timelineCharacterId || undefined,
    calendarStartTime: d.calendarStartTime || undefined, calendarEndTime: d.calendarEndTime || undefined,
    calendarDirection: d.calendarDirection || undefined,
    calendarDurationMinutes: Number(d.calendarDurationMinutes) || undefined,
    cardCharacterId: d.cardCharacterId || undefined, shortcutActionId: d.shortcutActionId || undefined,
  };
}

function PipeRow({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid rgba(150,190,230,.15)" }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>{label}</span>
      <Badge tone={ok ? "ok" : "red"} text={ok ? okText : badText} />
    </div>
  );
}

function describeShizuku(p: PipeStatus): string {
  if (!p.shizukuInstalled) return "未安装";
  if (!p.shizukuRunning) return "未运行";
  if (!p.shizukuPermission) return "未授权";
  return "未就绪";
}

/* ---------------- Tab 主体 ---------------- */

export function TabRules({ onNotice }: BridgeTabProps) {
  const [rules, setRules] = useState<HuaweiTriggerRule[]>(() => loadHuaweiTriggerRules());
  const [wizOpen, setWizOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const refresh = () => setRules(loadHuaweiTriggerRules());

  const openNew = () => { setDraft(blankDraft()); setWizOpen(true); };
  const openEdit = (r: HuaweiTriggerRule) => { setDraft(draftFromRule(r)); setWizOpen(true); };

  function toggleRule(id: string, on: boolean) {
    const next = loadHuaweiTriggerRules().map(r => (r.id === id ? { ...r, enabled: on } : r));
    saveHuaweiTriggerRules(next);
    refresh();
    onNotice?.(on ? "联动已启用" : "联动已停用");
  }

  function deleteRule(id: string) {
    const target = loadHuaweiTriggerRules().find(r => r.id === id);
    saveHuaweiTriggerRules(loadHuaweiTriggerRules().filter(r => r.id !== id));
    refresh();
    onNotice?.(`已删除「${target?.name ?? "联动"}」`);
  }

  function saveDraft(d: Draft) {
    const existing = loadHuaweiTriggerRules();
    const orig = existing.find(r => r.id === d.id);
    const rule: HuaweiTriggerRule = {
      id: d.id,
      name: d.name.trim() || "未命名联动",
      enabled: d.enabled,
      trigger: d.trigger,
      notifyPkg: d.trigger === "notification" ? d.notifyPkg.trim() || undefined : undefined,
      notifyKeyword: d.trigger === "notification" ? d.notifyKeyword.trim() || undefined : undefined,
      time: d.trigger === "time" ? d.time.trim() : undefined,
      days: d.trigger === "time" ? d.days : [],
      action: d.action,
      title: d.action === "send_notification" ? d.title.trim() || undefined : undefined,
      content: d.content.trim() || undefined,
      openApp: d.action === "send_notification" ? d.openApp.trim() || undefined : undefined,
      actionPackageName: d.action === "open_app" ? d.actionPackageName.trim() || undefined : undefined,
      actionName: d.action === "custom_action" ? d.actionName.trim() || undefined : undefined,
      processMode: d.processMode === "raw" ? undefined : d.processMode,
      contentTemplate: d.processMode === "template" ? d.contentTemplate.trim() || undefined : undefined,
      aiPrompt: d.processMode === "ai" ? d.aiPrompt.trim() || undefined : undefined,
      chatCharacterId: d.action === "chat" ? d.chatCharacterId || undefined : undefined,
      chatRole: d.action === "chat" ? d.chatRole : undefined,
      chatRequestReply: d.action === "chat" ? d.chatRequestReply : undefined,
      memoryCharacterId: d.action === "memory" ? d.memoryCharacterId || undefined : undefined,
      memoryScope: d.action === "memory" ? d.memoryScope : undefined,
      timelineCharacterId: d.action === "timeline" ? d.timelineCharacterId || undefined : undefined,
      calendarStartTime: d.action === "calendar" && !d.calendarDirection ? d.calendarStartTime || undefined : undefined,
      calendarEndTime: d.action === "calendar" && !d.calendarDirection ? d.calendarEndTime || undefined : undefined,
      calendarDirection: d.action === "calendar" ? d.calendarDirection || undefined : undefined,
      calendarDurationMinutes: d.action === "calendar" && d.calendarDirection ? Number(d.calendarDurationMinutes) || undefined : undefined,
      cardCharacterId: d.action === "card" ? d.cardCharacterId || undefined : undefined,
      shortcutActionId: d.action === "shortcut" ? d.shortcutActionId || undefined : undefined,
      lastTriggeredAt: orig?.lastTriggeredAt,
      lastSeenTs: orig?.lastSeenTs,
      triggerCount: orig?.triggerCount,
    };
    const idx = existing.findIndex(r => r.id === rule.id);
    const next = idx >= 0
      ? existing.map((r, i) => (i === idx ? rule : r))
      : [rule, ...existing];
    saveHuaweiTriggerRules(next);
    setRules(next);
    setWizOpen(false);
    setDraft(null);
    onNotice?.(idx >= 0 ? "联动已更新" : "联动已创建");
  }

  const seedDefaults = () => {
    const existing = loadHuaweiTriggerRules();
    const defaults: HuaweiTriggerRule[] = [
      { id: `seed_sleep`, name: "22:00 催睡", enabled: true, trigger: "time", time: "22:00", days: [], action: "send_notification", title: "该睡了", content: "明天5:30起，现在放下手机睡觉。" },
      { id: `seed_wake`, name: "5:30 起床", enabled: true, trigger: "time", time: "05:30", days: [], action: "send_notification", title: "起床了", content: "开始学习，今天也要加油。" },
      { id: `seed_study1`, name: "10:00 学习提醒", enabled: true, trigger: "time", time: "10:00", days: [], action: "send_notification", title: "学习时间", content: "休息一下，喝口水继续。" },
      { id: `seed_study2`, name: "14:00 学习提醒", enabled: true, trigger: "time", time: "14:00", days: [], action: "send_notification", title: "下午学习", content: "下午了，效率最高的时段。" },
      { id: `seed_study3`, name: "20:00 学习提醒", enabled: true, trigger: "time", time: "20:00", days: [], action: "send_notification", title: "晚间学习", content: "晚上是你效率最高的时候，别浪费。" },
      { id: `seed_xhs`, name: "小红书刷太久提醒", enabled: true, trigger: "notification", notifyPkg: "com.xingin.xhs", action: "send_notification", title: "刷太久了", content: "该回去学习了。" },
      { id: `seed_battery`, name: "低电量提醒", enabled: true, trigger: "notification", notifyKeyword: "电量", action: "send_notification", title: "该充电了", content: "手机快没电了，去充电。" },
    ];
    const merged = [...existing];
    for (const d of defaults) {
      if (!merged.find(r => r.id === d.id)) merged.push(d);
    }
    saveHuaweiTriggerRules(merged);
    refresh();
    onNotice?.("已恢复默认规则");
  };

  return (
    <div style={{ paddingTop: 6 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button style={{ ...BTN_GHOST, flex: 1 }} onClick={seedDefaults}>恢复默认规则</button>
      </div>
      {rules.length === 0 && !wizOpen ? (
        <EmptyState
          title="还没有联动规则"
          desc="当收到指定通知或到点时，自动发通知 / 打开 App / 写角色聊天记忆，把重复操作交给手机。"
          actionLabel="新建联动"
          onAction={openNew}
        />
      ) : (
        <>
          {rules.map(r => (
            <div key={r.id} style={{ ...CARD, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <b style={{ fontSize: 13.5, color: INK }}>{r.name}</b>
                    <Badge tone={r.trigger === "time" ? "gray" : "amber"} text={r.trigger === "time" ? "定时" : "通知"} />
                    {r.processMode === "ai" ? <Badge tone="gray" text="AI" /> : null}
                    {r.enabled ? null : <Badge tone="gray" text="已停用" />}
                  </div>
                  <div style={{ fontSize: 11.5, color: SUB, marginTop: 4, lineHeight: 1.6 }}>{summarize(r)}</div>
                  <div style={{ fontSize: 11, color: FAINT, marginTop: 6 }}>
                    上次触发 {fmtTime(r.lastTriggeredAt || 0)} · 共 {r.triggerCount || 0} 次 · 动作：{actionLabel(r.action)}
                  </div>
                </div>
                <Switch on={r.enabled} onChange={() => toggleRule(r.id, !r.enabled)} label={r.name} />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                <button type="button" style={{ ...BTN_GHOST, padding: "5px 14px" }} onClick={() => openEdit(r)}>编辑</button>
                <button type="button" style={{ ...BTN_RED, padding: "5px 14px" }} onClick={() => deleteRule(r.id)}>删除</button>
              </div>
            </div>
          ))}
          {!wizOpen ? (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
              <button type="button" style={{ ...BTN, padding: "10px 22px" }} onClick={openNew}>＋ 新建联动</button>
            </div>
          ) : null}
        </>
      )}

      {wizOpen && draft ? (
        <RuleWizard
          initial={draft}
          isExisting={rules.some(r => r.id === draft.id)}
          onClose={() => { setWizOpen(false); setDraft(null); }}
          onSave={saveDraft}
          onNotice={onNotice}
        />
      ) : null}
    </div>
  );
}
