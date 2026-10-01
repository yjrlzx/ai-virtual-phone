"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { getAndroidShell, parseShellJson } from "@/lib/huawei-shell/storage";
import type { ShellJsonResult } from "@/lib/huawei-shell/types";
import { linjianReadScreen, linjianTapText } from "@/lib/linjian-client";
import {
  CARD,
  BTN,
  BTN_GHOST,
  INPUT,
  GUIDE_BOX,
  INK,
  SUB,
  FAINT,
  Badge,
  SectionHeader,
  type BridgeTabProps,
} from "./shared";

/**
 * 操控应用 Tab（照搬 Operit 无障碍操控）：
 * 经无障碍服务实时读取前台 App 的 UI 层次结构，按文本点击 / 输入文字 / 模拟系统按键与手势。
 * 全部操作走 window.AndroidShell 真实桥方法，浏览器里壳未连接时优雅降级，不写死任何演示数据。
 */

type OpResult = { ok: boolean; detail: string; at: number };

/** 从 uiautomator dump（XML 文本）里抽取所有非空 text / content-desc，作为可点文本列表 */
function extractClickableTexts(dump: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:text|content-desc)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dump)) !== null) {
    const t = m[1].trim();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 60) break;
  }
  return out;
}

/** 从掌心窗 get_screen_nodes 返回的 JSON 里抽取短文本，作为可点文本列表 */
function extractClickableTextsFromJson(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let nodes: unknown = null;
  try {
    const parsed = JSON.parse(raw);
    nodes = (parsed as { nodes?: unknown[] } | null)?.nodes ?? parsed;
  } catch {
    return out;
  }
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const t = v.trim();
      if (t && t.length <= 40 && !seen.has(t)) { seen.add(t); out.push(t); }
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") {
      for (const k of ["text", "contentDesc", "desc", "content_description"]) {
        const val = (v as Record<string, unknown>)[k];
        if (typeof val === "string" && val.trim()) walk(val);
      }
    }
  };
  walk(nodes);
  return out.slice(0, 60);
}

const NUM_INPUT: CSSProperties = {
  ...INPUT,
  width: 64,
  padding: "7px 8px",
  textAlign: "center",
};

export function TabControl({ onNotice }: BridgeTabProps) {
  const [shellConnected, setShellConnected] = useState(false);
  const [a11yOn, setA11yOn] = useState<boolean | null>(null);

  const [dumpText, setDumpText] = useState("");
  const [clickables, setClickables] = useState<string[]>([]);
  const [dumping, setDumping] = useState(false);

  const [inputValue, setInputValue] = useState("");

  const [sx1, setSx1] = useState("");
  const [sy1, setSy1] = useState("");
  const [sx2, setSx2] = useState("");
  const [sy2, setSy2] = useState("");
  const [tx, setTx] = useState("");
  const [ty, setTy] = useState("");
  const [lx, setLx] = useState("");
  const [ly, setLy] = useState("");

  const [lastResult, setLastResult] = useState<OpResult | null>(null);

  const refreshStatus = () => {
    const shell = getAndroidShell();
    setShellConnected(shell !== null);
    if (shell?.accessibilityActive) {
      try { setA11yOn(shell.accessibilityActive()); }
      catch { setA11yOn(false); }
    } else {
      setA11yOn(null);
    }
  };

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 5000);
    return () => clearInterval(t);
  }, []);

  /** 统一执行一个桥方法并解析 {ok,error} 外壳；非 JSON 返回原样展示 */
  const run = (
    label: string,
    fn: (shell: NonNullable<ReturnType<typeof getAndroidShell>>) => string | undefined | null,
  ) => {
    const shell = getAndroidShell();
    if (!shell) {
      const r: OpResult = { ok: false, detail: "安卓壳未连接", at: Date.now() };
      setLastResult(r);
      onNotice?.("安卓壳未连接");
      return;
    }
    let raw: string | undefined | null;
    try {
      raw = fn(shell);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const r: OpResult = { ok: false, detail: `${label} 失败：${msg}`, at: Date.now() };
      setLastResult(r);
      onNotice?.(r.detail);
      return;
    }
    const parsed = parseShellJson<ShellJsonResult>(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.ok) {
        const r: OpResult = { ok: true, detail: `${label} 成功`, at: Date.now() };
        setLastResult(r);
        onNotice?.(r.detail);
      } else {
        const err = String(parsed.error ?? "未知错误");
        const r: OpResult = { ok: false, detail: `${label} 失败：${err}`, at: Date.now() };
        setLastResult(r);
        onNotice?.(r.detail);
      }
    } else {
      const text = raw && raw.trim() ? raw.trim() : "已执行";
      const r: OpResult = { ok: true, detail: `${label}：${text}`, at: Date.now() };
      setLastResult(r);
      onNotice?.(`${label} 完成`);
    }
  };

  const doDump = async () => {
    setDumping(true);
    // 优先掌心窗：拉无障碍节点树
    try {
      const lj = await linjianReadScreen();
      if (lj) {
        if (lj.ok) {
          setDumpText(lj.data);
          const list = extractClickableTextsFromJson(lj.data);
          setClickables(list);
          setLastResult({ ok: true, detail: `掌心窗已读屏，识别出 ${list.length} 个可点文本`, at: Date.now() });
          onNotice?.("掌心窗读屏成功");
        } else {
          setLastResult({ ok: false, detail: `掌心窗读屏失败：${lj.error}`, at: Date.now() });
          onNotice?.(`掌心窗读屏失败：${lj.error}`);
        }
        setDumping(false);
        return;
      }
    } catch { /* 回退壳端 */ }
    // 回退壳端 dumpScreen
    const shell = getAndroidShell();
    if (!shell?.dumpScreen) { onNotice?.("安卓壳未连接或不支持读取屏幕"); setDumping(false); return; }
    try {
      const raw = shell.dumpScreen() ?? "";
      setDumpText(raw);
      setClickables(extractClickableTexts(raw));
      setLastResult({ ok: true, detail: `已读取当前屏幕，识别出 ${extractClickableTexts(raw).length} 个可点文本`, at: Date.now() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastResult({ ok: false, detail: `读取屏幕失败：${msg}`, at: Date.now() });
      onNotice?.(`读取屏幕失败：${msg}`);
    } finally {
      setDumping(false);
    }
  };

  const doClickText = async (text: string) => {
    // 优先掌心窗 tap_text
    try {
      const lj = await linjianTapText({ text, match: "contains" });
      if (lj) {
        const r: OpResult = lj.ok
          ? { ok: true, detail: `掌心窗点击「${text}」成功`, at: Date.now() }
          : { ok: false, detail: `掌心窗点击失败：${lj.error}`, at: Date.now() };
        setLastResult(r);
        onNotice?.(r.detail);
        return;
      }
    } catch { /* 回退壳端 */ }
    run(`点击「${text}」`, shell => shell.clickText?.(text));
  };

  const doInput = () => {
    const t = inputValue;
    if (!t) { onNotice?.("请输入要填入当前输入框的文字"); return; }
    run("文字输入", shell => shell.inputText?.(t));
    setInputValue("");
  };

  const press = (key: "back" | "home" | "recents") => {
    const label = key === "back" ? "返回" : key === "home" ? "主页" : "多任务";
    run(label, shell => shell.pressKey?.(key));
  };

  const doSwipe = () => {
    const x1 = Number(sx1), y1 = Number(sy1), x2 = Number(sx2), y2 = Number(sy2);
    if ([x1, y1, x2, y2].some(n => !Number.isFinite(n))) { onNotice?.("请填写完整的滑动起点与终点坐标"); return; }
    run("滑动", shell => shell.swipe?.(x1, y1, x2, y2));
  };

  const doLongPress = () => {
    const x = Number(lx), y = Number(ly);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { onNotice?.("请填写长按坐标"); return; }
    run("长按", shell => shell.longPress?.(x, y));
  };

  const doTap = () => {
    const x = Number(tx), y = Number(ty);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { onNotice?.("请填写点按坐标"); return; }
    run("点按", shell => shell.tap?.(x, y));
  };

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 状态行：壳连接 + 无障碍是否开 */}
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Badge tone={shellConnected ? "ok" : "red"} text={shellConnected ? "壳已连接" : "壳未连接"} />
        <Badge
          tone={a11yOn === true ? "ok" : a11yOn === false ? "red" : "gray"}
          text={a11yOn === true ? "无障碍已开" : a11yOn === false ? "无障碍未开" : "无障碍未知"}
        />
        {!shellConnected ? (
          <button type="button" style={BTN_GHOST}
            onClick={() => run("无障碍设置", shell => shell.openPermissionSettings?.("accessibility"))}>
            去开无障碍
          </button>
        ) : null}
      </div>

      {/* 读取当前屏幕 */}
      <SectionHeader title="读取当前屏幕" desc="调无障碍服务 dump 前台 App 的 UI 层次结构，点文本直接点击" />
      <div style={CARD}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" style={BTN} onClick={doDump} disabled={!shellConnected || dumping}>
            {dumping ? "读取中…" : "读取当前屏幕"}
          </button>
          <span style={{ fontSize: 11.5, color: FAINT }}>
            {clickables.length ? `识别到 ${clickables.length} 个可点文本` : ""}
          </span>
        </div>

        {clickables.length > 0 ? (
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {clickables.map(t => (
              <button key={t} type="button" style={{ ...BTN_GHOST, padding: "5px 11px", fontSize: 12 }}
                onClick={() => doClickText(t)}>
                {t}
              </button>
            ))}
          </div>
        ) : null}

        {dumpText ? (
          <pre style={{
            marginTop: 10, maxHeight: 180, overflow: "auto",
            background: "rgba(150,190,230,.08)", borderRadius: 10,
            padding: 10, fontSize: 11, lineHeight: 1.5, color: SUB,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-all", marginBottom: 0,
          }}>
            {dumpText}
          </pre>
        ) : (
          <div style={{ fontSize: 12, color: FAINT, marginTop: 8 }}>
            还没读取过屏幕。点上面按钮后，这里会展示完整的 UI 层次结构文本。
          </div>
        )}
      </div>

      {/* 文字输入 */}
      <SectionHeader title="文字输入" desc="把文字填进当前焦点所在的输入框（如搜索框、聊天框）" />
      <div style={CARD}>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...INPUT, flex: 1 }} placeholder="输入要填入当前输入框的文字"
            value={inputValue} onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") doInput(); }} />
          <button type="button" style={BTN} onClick={doInput} disabled={!shellConnected}>填入</button>
        </div>
      </div>

      {/* 系统按键 */}
      <SectionHeader title="系统按键" desc="模拟安卓三大金刚键" />
      <div style={CARD}>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={BTN_GHOST} onClick={() => press("back")} disabled={!shellConnected}>返回</button>
          <button type="button" style={BTN_GHOST} onClick={() => press("home")} disabled={!shellConnected}>主页</button>
          <button type="button" style={BTN_GHOST} onClick={() => press("recents")} disabled={!shellConnected}>多任务</button>
        </div>
      </div>

      {/* 语义操作说明 */}
      <SectionHeader title="语义操控" desc="陆知行通过读屏幕树后，按文字/描述直接点按，不需要手动填坐标。" />

      {/* 最近一次操作结果 */}
      {lastResult ? (
        <div style={{ ...CARD, marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone={lastResult.ok ? "ok" : "red"} text={lastResult.ok ? "成功" : "失败"} />
            <span style={{ fontSize: 11, color: FAINT }}>{new Date(lastResult.at).toLocaleTimeString()}</span>
          </div>
          <div style={{
            marginTop: 8, fontSize: 12, color: SUB, lineHeight: 1.6,
            background: "rgba(150,190,230,.08)", borderRadius: 10, padding: 10,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>
            {lastResult.detail}
          </div>
        </div>
      ) : null}

      {!shellConnected ? (
        <div style={{ ...GUIDE_BOX, marginTop: 12, marginBottom: 0 }}>
          浏览器里看不到手机，按钮已禁用。在华为壳 App 内打开本页后，先在系统设置里开启无障碍服务，即可实时操控前台应用。
        </div>
      ) : null}
    </div>
  );
}
