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
} from "@/lib/huawei-shell/types";

/**
 * 自动联动 Tab：联动规则列表 + 6 步新建/编辑向导。
 * 规则数据全部来自 loadHuaweiTriggerRules()，运行时状态来自 window.AndroidShell，
 * 不写死演示数据；动作执行复用 rules.ts 的语义，这里只做增删改查 UI。
 */

const WIZ_STEP_NAMES = ["接通管道", "创建快捷指令", "选择信号", "加工内容", "决定动作", "测试与保存"] as const;

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
  processMode: "raw" | "template";
  contentTemplate: string;
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
    processMode: r.processMode === "template" ? "template" : "raw",
    contentTemplate: r.contentTemplate ?? "",
  };
}

function actionLabel(a: HuaweiTriggerRuleAction): string {
  return a === "send_notification" ? "发通知" : a === "open_app" ? "打开应用" : "自定义动作";
}

/** 一行摘要：触发条件 → 动作 */
function summarize(r: Pick<HuaweiTriggerRule, "trigger" | "notifyPkg" | "notifyKeyword" | "time" | "days" | "action" | "title" | "actionPackageName" | "actionName">): string {
  const trig = r.trigger === "time"
    ? `定时 ${r.time || "--:--"}${r.days && r.days.length > 0
      ? `（${r.days.map(d => WEEKDAYS.find(w => w.key === d)?.label ?? d).join("/")}）`
      : "（每天）"}`
    : `通知来自 ${r.notifyPkg || "任意来源"}${r.notifyKeyword ? `，含「${r.notifyKeyword}」` : ""}`;
  const act = r.action === "send_notification"
    ? `发通知「${r.title || ""}」`
    : r.action === "open_app"
      ? `打开应用 ${r.actionPackageName || ""}`
      : `调用自定义动作 ${r.actionName || ""}`;
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

/* ---------------- 向导主体（受控外壳，与 WizardShell 同视觉） ---------------- */

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
  const [recentNotifs, setRecentNotifs] = useState<Array<{ pkg: string; title: string; text: string }> | null>(null);

  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));

  const refreshPipe = () => setPipe(readPipeStatus());

  useEffect(() => {
    refreshPipe();
  }, []);

  const customActions = loadHuaweiCustomActions();

  /* 各步必填校验；返回 null 表示可下一步 */
  function blocker(): string | null {
    if (step === 2 && !draft.action) return "请选择一个动作类型";
    if (step === 3 && draft.trigger === "time" && !/^\d{2}:\d{2}$/.test(draft.time.trim())) {
      return "请设置正确的触发时间（HH:MM）";
    }
    if (step === 5) {
      if (draft.action === "send_notification" && (!draft.title.trim() || !draft.content.trim())) {
        return "发通知需要填写标题和正文";
      }
      if (draft.action === "open_app" && !draft.actionPackageName.trim()) {
        return "请填写要打开的应用包名";
      }
      if (draft.action === "custom_action" && !draft.actionName.trim()) {
        return "请选择一个已登记的自定义动作";
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

      {/* 步骤条（与 WizardShell 一致） */}
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
            提示：通知类规则还需要「通知监听」权限；定时类规则无需 Shizuku 也能按点触发。
          </div>
        </div>
      ) : null}

      {/* ---------- 第 2 步 创建快捷指令（定义动作类型） ---------- */}
      {step === 2 ? (
        <div>
          <p style={{ fontSize: 12, color: SUB, lineHeight: 1.7, margin: "0 0 8px" }}>
            这条联动触发后要做什么？选一个动作类型，下一步再填它的参数。
          </p>
          {([
            { v: "send_notification", t: "发通知", d: "在通知栏弹一条提醒" },
            { v: "open_app", t: "打开应用", d: "自动跳到指定 App" },
            { v: "custom_action", t: "自定义动作", d: "调用你登记过的动作" },
          ] as Array<{ v: HuaweiTriggerRuleAction; t: string; d: string }>).map(opt => {
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
            命中通知后，怎么组织要发出去的内容？
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            {([
              { v: "raw" as const, t: "原样固定文案" },
              { v: "template" as const, t: "模板加工" },
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
                {`{payload} 会替换成命中通知的标题与正文`}；{`{title}`} 仅标题、{`{text}`} 仅正文。定时触发没有通知内容，占位会替换为空。
              </div>
            </>
          ) : (
            <div style={GUIDE_BOX}>
              按下一步填好的固定标题与正文发送，不引用通知里的内容。定时触发走这种方式。
            </div>
          )}
        </div>
      ) : null}

      {/* ---------- 第 5 步 决定动作（按动作类型填参数） ---------- */}
      {step === 5 ? (
        <div>
          {draft.action === "send_notification" ? (
            <>
              <label style={fieldLabel}>通知标题</label>
              <input style={INPUT} value={draft.title} onChange={e => set({ title: e.target.value })} placeholder="如 该喝水了" />
              <label style={fieldLabel}>通知正文{draft.processMode === "template" ? "（兜底固定文案，模板未命中占位时使用）" : ""}</label>
              <input style={INPUT} value={draft.content} onChange={e => set({ content: e.target.value })} placeholder="如 定时提醒" />
              {draft.processMode === "template" ? (
                <div style={{ ...GUIDE_BOX, marginTop: 8 }}>
                  当前为模板加工：实际发送的正文来自第 4 步模板，这里的固定文案只作兜底。
                </div>
              ) : null}
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
        </div>
      ) : null}

      {/* ---------- 第 6 步 测试与保存 ---------- */}
      {step === 6 ? (
        <div>
          <div style={{ ...CARD, boxShadow: "none", background: "rgba(106,176,243,.08)", padding: "10px 12px" }}>
            <b style={{ fontSize: 13, color: INK }}>{draft.name.trim() || "未命名联动"}</b>
            <div style={{ fontSize: 12, color: SUB, marginTop: 4, lineHeight: 1.6 }}>{summarize(draft)}</div>
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
                  <div key={i} style={{ fontSize: 11.5, color: SUB, padding: "5px 0", borderBottom: "1px solid rgba(150,190,230,.15)" }}>
                    <Badge tone="gray" text={n.pkg || "未知"} /> <span style={{ marginLeft: 6 }}>{n.title || n.text}</span>
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
      content: d.action === "send_notification" ? d.content.trim() || undefined : undefined,
      openApp: d.action === "send_notification" ? d.openApp.trim() || undefined : undefined,
      actionPackageName: d.action === "open_app" ? d.actionPackageName.trim() || undefined : undefined,
      actionName: d.action === "custom_action" ? d.actionName.trim() || undefined : undefined,
      processMode: d.processMode === "template" ? "template" : undefined,
      contentTemplate: d.processMode === "template" ? d.contentTemplate.trim() || undefined : undefined,
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

  return (
    <div style={{ paddingTop: 6 }}>
      {rules.length === 0 && !wizOpen ? (
        <EmptyState
          title="还没有联动规则"
          desc="当收到指定通知或到点时，自动发通知 / 打开 App，把重复操作交给手机。"
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
