"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { kvGet, kvSet } from "@/lib/kv-db";
import { getAndroidShell } from "@/lib/huawei-shell/storage";
import type { HuaweiShellBridge } from "@/lib/huawei-shell/types";

/**
 * 现实桥（安卓版）—— 四个 Tab 共用的视觉令牌与基础原子。
 *
 * 视觉沿用华为现实桥已落地的 Y2K 冰蓝千禧复古：主色渐变 #6ab0f3→#8ec5fc，
 * 内容卡片纯白平面，磨砂玻璃只用于悬浮按钮。所有运行时数据都来自
 * window.AndroidShell 或本地 kv 缓存，绝不写死演示数据。
 */

/* ---------------- 视觉令牌 ---------------- */

export const ACCENT = "linear-gradient(135deg, #6ab0f3, #8ec5fc)";
export const INK = "#2c4a6e";
export const SUB = "#5a7a9e";
export const FAINT = "#8aa8c8";
export const GREEN = "#2fa46a";
export const AMBER = "#e8a33d";
export const RED = "#d9534f";

export const CARD: CSSProperties = {
  background: "#fff",
  borderRadius: 18,
  padding: "14px 16px",
  boxShadow: "0 2px 10px rgba(90,130,180,.08)",
};

export const BTN: CSSProperties = {
  border: "none",
  borderRadius: 999,
  padding: "8px 16px",
  fontSize: 12.5,
  fontWeight: 700,
  cursor: "pointer",
  background: ACCENT,
  color: "#fff",
  whiteSpace: "nowrap",
};

export const BTN_GHOST: CSSProperties = {
  ...BTN,
  background: "rgba(150,190,230,.15)",
  color: "#4a6a8e",
};

export const BTN_RED: CSSProperties = {
  ...BTN,
  background: "rgba(217,83,79,.12)",
  color: RED,
};

export const INPUT: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid rgba(150,190,230,.45)",
  borderRadius: 12,
  padding: "9px 12px",
  fontSize: 13,
  color: INK,
  background: "rgba(248,251,255,.9)",
  outline: "none",
};

export const GUIDE_BOX: CSSProperties = {
  background: "rgba(106,176,243,.09)",
  borderRadius: 12,
  padding: 12,
  fontSize: 12,
  color: SUB,
  lineHeight: 1.75,
  marginTop: 10,
};

/* ---------------- Tab 通用 props ---------------- */

export type BridgeTabProps = {
  onNotice?: (text: string) => void;
};

/* ---------------- 本地 kv 读写 ---------------- */

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = kvGet(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value));
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function fmtTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--";
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/* ---------------- 桥调用封装 ---------------- */

export type ShellActionLog = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  at: number;
};

/** 统一桥调用：未连接 / 抛错都记录到日志，返回是否成功 */
export function runShellAction(
  label: string,
  fn: (shell: HuaweiShellBridge) => unknown,
): { ok: boolean; detail: string } {
  const shell = getAndroidShell();
  if (!shell) return { ok: false, detail: "安卓壳未连接" };
  try {
    const raw = fn(shell);
    const text = typeof raw === "string" && raw.trim() ? raw : "已执行";
    return { ok: true, detail: text };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------------- 基础原子组件 ---------------- */

export function Badge({ tone, text }: { tone: "ok" | "red" | "amber" | "gray"; text: string }) {
  const map: Record<string, CSSProperties> = {
    ok: { background: "rgba(47,164,106,.13)", color: GREEN },
    red: { background: "rgba(217,83,79,.13)", color: RED },
    amber: { background: "rgba(232,163,61,.16)", color: "#c8902e" },
    gray: { background: "rgba(138,168,200,.14)", color: FAINT },
  };
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999, whiteSpace: "nowrap", ...map[tone] }}>
      {text}
    </span>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label ?? "开关"}
      onClick={onChange}
      style={{
        width: 46,
        height: 26,
        borderRadius: 999,
        border: "none",
        background: on ? GREEN : "rgba(150,190,230,.35)",
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background .2s",
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          ...(on ? { right: 3 } : { left: 3 }),
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,.2)",
          transition: "left .2s, right .2s",
        }}
      />
    </button>
  );
}

export function EmptyState({ title, desc, actionLabel, onAction }: {
  title: string;
  desc: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div style={{ textAlign: "center", padding: "36px 10px" }}>
      <b style={{ display: "block", fontSize: 15, color: INK, marginBottom: 6 }}>{title}</b>
      <p style={{ fontSize: 12.5, color: FAINT, lineHeight: 1.7, margin: "0 0 16px" }}>{desc}</p>
      <button type="button" style={BTN} onClick={onAction}>{actionLabel}</button>
    </div>
  );
}

/** 卡片开关行：标题 + 描述 + 开关 */
export function CardRow({ title, desc, on, onToggle }: {
  title: string;
  desc?: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid rgba(150,190,230,.15)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{title}</div>
        {desc ? <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>{desc}</div> : null}
      </div>
      <Switch on={on} onChange={onToggle} label={title} />
    </div>
  );
}

/* ---------------- 分步向导外壳 ---------------- */

export function WizardShell({ steps, step, title, children, footer }: {
  steps: readonly string[];
  step: number;
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {!open ? (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
          <button type="button" onClick={() => setOpen(true)} style={{ ...BTN, padding: "10px 22px" }}>
            {title}
          </button>
        </div>
      ) : (
        <div style={{ ...CARD, marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <b style={{ fontSize: 14, color: INK }}>{title}</b>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭向导" style={{ ...BTN_GHOST, padding: "4px 12px" }}>
              关闭
            </button>
          </div>
          {/* 步骤条 */}
          <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
            {steps.map((s, i) => (
              <div key={s} style={{ flex: 1, textAlign: "center" }}>
                <div
                  style={{
                    height: 4,
                    borderRadius: 2,
                    background: i < step ? ACCENT : "rgba(150,190,230,.25)",
                    marginBottom: 5,
                  }}
                />
                <div style={{ fontSize: 10, color: i + 1 === step ? INK : FAINT, fontWeight: i + 1 === step ? 700 : 500 }}>
                  {i + 1}. {s}
                </div>
              </div>
            ))}
          </div>
          <div>{children}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>{footer}</div>
        </div>
      )}
    </>
  );
}
