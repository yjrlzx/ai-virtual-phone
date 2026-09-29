$ErrorActionPreference = "Stop"
$p = "C:\Users\杨静茹\Desktop\ai-virtual-phone-src\components\huawei-shell-settings.tsx"
$c = [IO.File]::ReadAllText($p)

# 1) lucide 图标补 Wand2 / Workflow
$oldIcon = @'
    Timer,
    Trash2,
    Volume2,
    Wifi,
    Zap,
} from "lucide-react";
'@
$newIcon = @'
    Timer,
    Trash2,
    Volume2,
    Wand2,
    Wifi,
    Workflow,
    Zap,
} from "lucide-react";
'@
if (-not $c.Contains($oldIcon)) { throw "icon anchor MISS" }
$c = $c.Replace($oldIcon, $newIcon)
Write-Output "icons: OK"

# 2) storage import 补函数 + types import
$oldImp = @'
    saveHuaweiShellSettings,
    syncHuaweiLedgerFromShell,
    type HuaweiShellSettings,
} from "@/lib/huawei-shell/storage";
'@
$newImp = @'
    loadHuaweiCustomActions,
    loadHuaweiShellSettings,
    loadHuaweiTriggerRules,
    saveHuaweiCustomActions,
    saveHuaweiShellSettings,
    saveHuaweiTriggerRules,
    syncHuaweiLedgerFromShell,
    type HuaweiShellSettings,
} from "@/lib/huawei-shell/storage";
import type {
    HuaweiCustomAction,
    HuaweiCustomActionType,
    HuaweiStatusKey,
    HuaweiTriggerRule,
    HuaweiTriggerRuleAction,
    HuaweiTriggerRuleTrigger,
} from "@/lib/huawei-shell/types";
'@
if (-not $c.Contains($oldImp)) { throw "storage import anchor MISS" }
$c = $c.Replace($oldImp, $newImp)
Write-Output "imports: OK"

# 3) state + 常量 + handlers（插在 handleReset 之前）
$oldState = @'
    const handleReset = () => {
'@
$newState = @'
    /* ---------- 自定义快捷动作 ---------- */
    const HUAWEI_BUILTIN_TOOL_NAMES = new Set([
        "查看手机状态", "实时天气", "查询位置", "查看当前应用", "查看通知", "查看记账", "读取微信消息",
        "打开应用", "点击文字", "输入文字", "滑动屏幕", "按键操作", "专注模式", "定时息屏", "发送提醒",
        "查看设备详情", "调节音量", "调节亮度", "读取剪贴板", "写入剪贴板", "打开网页", "读取文件",
    ]);
    const [actions, setActions] = useState<HuaweiCustomAction[]>(() => loadHuaweiCustomActions());
    const [actionDraft, setActionDraft] = useState({
        name: "",
        type: "open_app" as HuaweiCustomActionType,
        description: "",
        packageName: "",
        title: "",
        content: "",
        openApp: "",
        statusKey: "battery" as HuaweiStatusKey,
        command: "",
    });

    const huaweiActionTypeLabel = (type: HuaweiCustomActionType): string => {
        switch (type) {
            case "open_app": return "打开应用";
            case "send_notification": return "发通知";
            case "read_status": return "读状态";
            case "shell": return "Shell 命令";
            default: return type;
        }
    };

    const addCustomAction = () => {
        const name = actionDraft.name.trim();
        if (!name) { onNotice?.("先填动作名（char 调用时用的工具名）"); return; }
        if (HUAWEI_BUILTIN_TOOL_NAMES.has(name)) { onNotice?.("与内置工具重名，换个名字"); return; }
        if (actions.some(a => a.name === name)) { onNotice?.("已有同名动作"); return; }
        if (actionDraft.type === "open_app" && !actionDraft.packageName.trim()) { onNotice?.("打开应用需填包名"); return; }
        if (actionDraft.type === "send_notification" && (!actionDraft.title.trim() || !actionDraft.content.trim())) { onNotice?.("发通知需填标题和内容"); return; }
        if (actionDraft.type === "shell" && !actionDraft.command.trim()) { onNotice?.("Shell 动作需填命令"); return; }
        const next: HuaweiCustomAction[] = [...actions, {
            id: `action_${Date.now().toString(36)}_${actions.length}`,
            name,
            type: actionDraft.type,
            description: actionDraft.description.trim(),
            packageName: actionDraft.type === "open_app" ? actionDraft.packageName.trim() : undefined,
            title: actionDraft.type === "send_notification" ? actionDraft.title.trim() : undefined,
            content: actionDraft.type === "send_notification" ? actionDraft.content.trim() : undefined,
            openApp: actionDraft.type === "send_notification" ? (actionDraft.openApp.trim() || undefined) : undefined,
            statusKey: actionDraft.type === "read_status" ? actionDraft.statusKey : undefined,
            command: actionDraft.type === "shell" ? actionDraft.command.trim() : undefined,
            enabled: true,
            createdAt: Date.now(),
        }];
        setActions(next);
        saveHuaweiCustomActions(next);
        setActionDraft({ name: "", type: "open_app", description: "", packageName: "", title: "", content: "", openApp: "", statusKey: "battery", command: "" });
        onNotice?.(`已登记自定义动作「${name}」：char 现在可以按名字直接调用`);
    };

    const toggleAction = (id: string) => {
        const next = actions.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a);
        setActions(next);
        saveHuaweiCustomActions(next);
    };

    const removeAction = (id: string) => {
        const target = actions.find(a => a.id === id);
        const next = actions.filter(a => a.id !== id);
        setActions(next);
        saveHuaweiCustomActions(next);
        onNotice?.(target ? `已删除自定义动作「${target.name}」` : "已删除");
    };

    /* ---------- 自动联动规则 ---------- */
    const WEEKDAY_LABELS = [
        { key: "mon", label: "一" }, { key: "tue", label: "二" }, { key: "wed", label: "三" },
        { key: "thu", label: "四" }, { key: "fri", label: "五" }, { key: "sat", label: "六" }, { key: "sun", label: "日" },
    ];
    const [rules, setRules] = useState<HuaweiTriggerRule[]>(() => loadHuaweiTriggerRules());
    const [ruleDraft, setRuleDraft] = useState({
        name: "",
        trigger: "notification" as HuaweiTriggerRuleTrigger,
        notifyPkg: "",
        notifyKeyword: "",
        time: "",
        days: [] as string[],
        action: "send_notification" as HuaweiTriggerRuleAction,
        title: "",
        content: "",
        openApp: "",
        actionPackageName: "",
    });

    const ruleSummary = (r: HuaweiTriggerRule): string => {
        const triggerText = r.trigger === "time"
            ? `每天 ${r.time ?? ""}${r.days && r.days.length > 0 ? `（${r.days.join("/")}）` : ""}`
            : r.notifyPkg === "payment" ? "收到微信/支付宝支付通知"
            : r.notifyPkg ? `收到 ${r.notifyPkg} 通知` : "收到任意通知";
        const actionText = r.action === "send_notification" ? `发提醒「${r.title ?? ""}」` : `打开应用 ${r.actionPackageName ?? ""}`;
        return `${triggerText} → ${actionText}`;
    };

    const toggleDay = (day: string) => {
        setRuleDraft(prev => ({
            ...prev,
            days: prev.days.includes(day) ? prev.days.filter(d => d !== day) : [...prev.days, day],
        }));
    };

    const addRule = () => {
        const name = ruleDraft.name.trim();
        if (!name) { onNotice?.("先填规则名"); return; }
        if (ruleDraft.trigger === "time" && !/^\d{2}:\d{2}$/.test(ruleDraft.time.trim())) { onNotice?.("定时触发需填时间（HH:MM，如 08:00）"); return; }
        if (ruleDraft.action === "send_notification" && (!ruleDraft.title.trim() || !ruleDraft.content.trim())) { onNotice?.("发通知提醒需填标题和内容"); return; }
        if (ruleDraft.action === "open_app" && !ruleDraft.actionPackageName.trim()) { onNotice?.("打开应用需填包名"); return; }
        const next: HuaweiTriggerRule[] = [...rules, {
            id: `rule_${Date.now().toString(36)}_${rules.length}`,
            name,
            enabled: true,
            trigger: ruleDraft.trigger,
            notifyPkg: ruleDraft.trigger === "notification" ? (ruleDraft.notifyPkg.trim() || undefined) : undefined,
            notifyKeyword: ruleDraft.trigger === "notification" ? (ruleDraft.notifyKeyword.trim() || undefined) : undefined,
            time: ruleDraft.trigger === "time" ? ruleDraft.time.trim() : undefined,
            days: ruleDraft.trigger === "time" ? (ruleDraft.days.length > 0 ? [...ruleDraft.days] : undefined) : undefined,
            action: ruleDraft.action,
            title: ruleDraft.action === "send_notification" ? ruleDraft.title.trim() : undefined,
            content: ruleDraft.action === "send_notification" ? ruleDraft.content.trim() : undefined,
            openApp: ruleDraft.action === "send_notification" ? (ruleDraft.openApp.trim() || undefined) : undefined,
            actionPackageName: ruleDraft.action === "open_app" ? ruleDraft.actionPackageName.trim() : undefined,
        }];
        setRules(next);
        saveHuaweiTriggerRules(next);
        setRuleDraft({ name: "", trigger: "notification", notifyPkg: "", notifyKeyword: "", time: "", days: [], action: "send_notification", title: "", content: "", openApp: "", actionPackageName: "" });
        onNotice?.(`已创建联动规则「${name}」，常驻检查会自动触发`);
    };

    const toggleRule = (id: string) => {
        const next = rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r);
        setRules(next);
        saveHuaweiTriggerRules(next);
    };

    const removeRule = (id: string) => {
        const target = rules.find(r => r.id === id);
        const next = rules.filter(r => r.id !== id);
        setRules(next);
        saveHuaweiTriggerRules(next);
        onNotice?.(target ? `已删除联动规则「${target.name}」` : "已删除");
    };

    const handleReset = () => {
'@
if (-not $c.Contains($oldState)) { throw "state anchor MISS" }
$c = $c.Replace($oldState, $newState)
Write-Output "state+handlers: OK"

# 4) JSX 两大区块（插在 快速测试 之前）
$oldJsx = @'
            {/* 快速测试 */}
'@
$newJsx = @'
            {/* 自定义快捷动作 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Wand2 size={16} /> 自定义快捷动作（登记后 char 可直接调用）</div>
                <div className="hw-field">
                    <label className="hw-field-label">动作名（char 调用名）</label>
                    <input
                        className="hw-input"
                        value={actionDraft.name}
                        onChange={e => setActionDraft(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="如 打开微信"
                        spellCheck={false}
                    />
                </div>
                <div className="hw-field">
                    <label className="hw-field-label">动作类型</label>
                    <select className="hw-select" value={actionDraft.type} onChange={e => setActionDraft(prev => ({ ...prev, type: e.target.value as HuaweiCustomActionType }))}>
                        <option value="open_app">打开指定应用（包名）</option>
                        <option value="send_notification">给手机发一条通知（标题+内容）</option>
                        <option value="read_status">读取内置状态（电量/位置/当前应用等）</option>
                        <option value="shell">执行一段 shell 命令</option>
                    </select>
                </div>
                {actionDraft.type === "open_app" && (
                    <div className="hw-field">
                        <label className="hw-field-label">应用包名</label>
                        <input
                            className="hw-input"
                            value={actionDraft.packageName}
                            onChange={e => setActionDraft(prev => ({ ...prev, packageName: e.target.value }))}
                            placeholder="如 com.tencent.mm"
                            spellCheck={false}
                        />
                    </div>
                )}
                {actionDraft.type === "send_notification" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">提醒标题</label>
                            <input className="hw-input" value={actionDraft.title} onChange={e => setActionDraft(prev => ({ ...prev, title: e.target.value }))} placeholder="标题" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">提醒内容</label>
                            <input className="hw-input" value={actionDraft.content} onChange={e => setActionDraft(prev => ({ ...prev, content: e.target.value }))} placeholder="内容" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">点击后打开的应用包名（可选）</label>
                            <input className="hw-input" value={actionDraft.openApp} onChange={e => setActionDraft(prev => ({ ...prev, openApp: e.target.value }))} placeholder="如 com.tencent.mm" spellCheck={false} />
                        </div>
                    </>
                )}
                {actionDraft.type === "read_status" && (
                    <div className="hw-field">
                        <label className="hw-field-label">要读取的状态</label>
                        <select className="hw-select" value={actionDraft.statusKey} onChange={e => setActionDraft(prev => ({ ...prev, statusKey: e.target.value as HuaweiStatusKey }))}>
                            <option value="battery">电量</option>
                            <option value="volume">媒体音量</option>
                            <option value="network">网络连接</option>
                            <option value="accessibility">无障碍服务</option>
                            <option value="floating">悬浮球</option>
                            <option value="locked">门禁锁数量</option>
                            <option value="location">位置</option>
                            <option value="current_app">当前应用</option>
                        </select>
                    </div>
                )}
                {actionDraft.type === "shell" && (
                    <div className="hw-field">
                        <label className="hw-field-label">要执行的命令</label>
                        <input
                            className="hw-input"
                            value={actionDraft.command}
                            onChange={e => setActionDraft(prev => ({ ...prev, command: e.target.value }))}
                            placeholder="如 getprop ro.build.version.release"
                            spellCheck={false}
                        />
                    </div>
                )}
                <div className="hw-field">
                    <label className="hw-field-label">使用说明（告诉 char 什么时候用，可选）</label>
                    <input
                        className="hw-input"
                        value={actionDraft.description}
                        onChange={e => setActionDraft(prev => ({ ...prev, description: e.target.value }))}
                        placeholder="如 用户说「帮我开微信」时用"
                        spellCheck={false}
                    />
                </div>
                <div className="hw-field-row">
                    <button type="button" className="hw-btn hw-btn-primary" onClick={addCustomAction}>
                        <Plus size={14} /> 登记动作
                    </button>
                    <span className="hw-field-hint">登记后自动变成 char 工具；名字不能与内置工具重名</span>
                </div>
                {actions.length === 0 && <span className="hw-field-hint">还没有自定义动作。示例：登记「打开微信」→ char 说“打开微信”时直接执行</span>}
                {actions.map(a => (
                    <div className="hw-action-row" key={a.id}>
                        <div className="hw-action-copy">
                            <div className="hw-action-name">{a.name}</div>
                            <div className="hw-action-sub">{huaweiActionTypeLabel(a.type)}{a.description ? ` · ${a.description}` : ""}</div>
                        </div>
                        <button
                            type="button"
                            className={`hw-switch hw-switch-sm ${a.enabled ? "hw-switch-on" : ""}`}
                            role="switch"
                            aria-checked={a.enabled}
                            onClick={() => toggleAction(a.id)}
                        >
                            <span className="hw-switch-knob" />
                        </button>
                        <button type="button" className="hw-btn hw-btn-mini hw-btn-danger" onClick={() => removeAction(a.id)} aria-label={`删除 ${a.name}`}>
                            <Trash2 size={12} />
                        </button>
                    </div>
                ))}
            </div>

            {/* 自动联动规则 */}
            <div className="hw-shell-card">
                <div className="hw-win-dots"><i /><i /><i /></div>
                <div className="hw-card-title"><Workflow size={16} /> 自动联动规则（收到通知 / 定时 → 自动动作）</div>
                <div className="hw-field">
                    <label className="hw-field-label">规则名</label>
                    <input
                        className="hw-input"
                        value={ruleDraft.name}
                        onChange={e => setRuleDraft(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="如 支付到账提醒"
                        spellCheck={false}
                    />
                </div>
                <div className="hw-field">
                    <label className="hw-field-label">触发方式</label>
                    <select className="hw-select" value={ruleDraft.trigger} onChange={e => setRuleDraft(prev => ({ ...prev, trigger: e.target.value as HuaweiTriggerRuleTrigger }))}>
                        <option value="notification">收到通知时</option>
                        <option value="time">到达时间点时</option>
                    </select>
                </div>
                {ruleDraft.trigger === "notification" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">来源（支付通知 = 微信/支付宝；留空 = 任意通知）</label>
                            <select className="hw-select" value={ruleDraft.notifyPkg} onChange={e => setRuleDraft(prev => ({ ...prev, notifyPkg: e.target.value }))}>
                                <option value="">任意来源</option>
                                <option value="payment">微信/支付宝支付通知</option>
                                <option value="com.tencent.mm">微信</option>
                                <option value="com.eg.android.AlipayGphone">支付宝</option>
                            </select>
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">通知关键词（可选）</label>
                            <input
                                className="hw-input"
                                value={ruleDraft.notifyKeyword}
                                onChange={e => setRuleDraft(prev => ({ ...prev, notifyKeyword: e.target.value }))}
                                placeholder="如 到账"
                                spellCheck={false}
                            />
                        </div>
                    </>
                )}
                {ruleDraft.trigger === "time" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">触发时间（HH:MM）</label>
                            <input
                                className="hw-input"
                                value={ruleDraft.time}
                                onChange={e => setRuleDraft(prev => ({ ...prev, time: e.target.value }))}
                                placeholder="如 08:00"
                                spellCheck={false}
                            />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">星期（不选 = 每天）</label>
                            <div className="hw-chip-row">
                                {WEEKDAY_LABELS.map(({ key, label }) => (
                                    <button
                                        type="button"
                                        key={key}
                                        className={`hw-chip ${ruleDraft.days.includes(key) ? "hw-chip-on" : ""}`}
                                        onClick={() => toggleDay(key)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </>
                )}
                <div className="hw-field">
                    <label className="hw-field-label">触发后执行</label>
                    <select className="hw-select" value={ruleDraft.action} onChange={e => setRuleDraft(prev => ({ ...prev, action: e.target.value as HuaweiTriggerRuleAction }))}>
                        <option value="send_notification">发通知提醒</option>
                        <option value="open_app">打开应用</option>
                    </select>
                </div>
                {ruleDraft.action === "send_notification" && (
                    <>
                        <div className="hw-field">
                            <label className="hw-field-label">提醒标题</label>
                            <input className="hw-input" value={ruleDraft.title} onChange={e => setRuleDraft(prev => ({ ...prev, title: e.target.value }))} placeholder="标题" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">提醒内容</label>
                            <input className="hw-input" value={ruleDraft.content} onChange={e => setRuleDraft(prev => ({ ...prev, content: e.target.value }))} placeholder="内容" spellCheck={false} />
                        </div>
                        <div className="hw-field">
                            <label className="hw-field-label">点击后打开的应用包名（可选）</label>
                            <input className="hw-input" value={ruleDraft.openApp} onChange={e => setRuleDraft(prev => ({ ...prev, openApp: e.target.value }))} placeholder="如 com.tencent.mm" spellCheck={false} />
                        </div>
                    </>
                )}
                {ruleDraft.action === "open_app" && (
                    <div className="hw-field">
                        <label className="hw-field-label">应用包名</label>
                        <input className="hw-input" value={ruleDraft.actionPackageName} onChange={e => setRuleDraft(prev => ({ ...prev, actionPackageName: e.target.value }))} placeholder="如 com.tencent.mm" spellCheck={false} />
                    </div>
                )}
                <div className="hw-field-row">
                    <button type="button" className="hw-btn hw-btn-primary" onClick={addRule}>
                        <Plus size={14} /> 创建规则
                    </button>
                    <span className="hw-field-hint">页面开着时常驻检查，命中自动执行</span>
                </div>
                {rules.length === 0 && <span className="hw-field-hint">还没有联动规则。示例：收到微信支付通知 → 发提醒「已到账」</span>}
                {rules.map(r => (
                    <div className="hw-action-row" key={r.id}>
                        <div className="hw-action-copy">
                            <div className="hw-action-name">{r.name}</div>
                            <div className="hw-action-sub">{ruleSummary(r)}{r.triggerCount ? ` · 已触发 ${r.triggerCount} 次` : ""}</div>
                        </div>
                        <button
                            type="button"
                            className={`hw-switch hw-switch-sm ${r.enabled ? "hw-switch-on" : ""}`}
                            role="switch"
                            aria-checked={r.enabled}
                            onClick={() => toggleRule(r.id)}
                        >
                            <span className="hw-switch-knob" />
                        </button>
                        <button type="button" className="hw-btn hw-btn-mini hw-btn-danger" onClick={() => removeRule(r.id)} aria-label={`删除 ${r.name}`}>
                            <Trash2 size={12} />
                        </button>
                    </div>
                ))}
                <div className="hw-field">
                    <label className="hw-field-label">规则检查间隔（秒，10-300）</label>
                    <input
                        className="hw-input hw-input-num"
                        type="number"
                        min={10}
                        max={300}
                        value={settings.ruleCheckIntervalSec}
                        onChange={e => updateSettings({ ruleCheckIntervalSec: Math.round(Number(e.target.value) || 30) })}
                    />
                </div>
            </div>

            {/* 快速测试 */}
'@
if (-not $c.Contains($oldJsx)) { throw "jsx anchor MISS" }
$c = $c.Replace($oldJsx, $newJsx)
Write-Output "jsx: OK"

[IO.File]::WriteAllText($p, $c, (New-Object Text.UTF8Encoding $false))
Write-Output "settings ui done"
