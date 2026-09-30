"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { HuaweiShellSettings } from "./huawei-shell-settings";
import { HuaweiBridgeWizard } from "./huawei-bridge-wizard";

/**
 * 华为现实桥 —— float 桌面独立 App 外壳。
 *
 * 顶部 titlebar：左 ← 返回（onClose）、中标题「华为现实桥」、右「⋯」菜单。
 * 点「⋯」展开/收起 HuaweiShellSettings 折叠面板（默认收起，主界面保持干净）；
 * 主体滚动区渲染双页 HuaweiBridgeWizard。HuaweiShellSettings 本身不改，仅换挂载位置。
 */

/* 顶栏必须让到虚拟状态栏下方：.phone-status-bar 绝对定位 z-index:10，会盖住屏幕顶部
   约 48px 并拦截触摸，返回按钮压在其下就点不动。与 reality-bridge 的 .rb-header 同值。 */
const SAFE_TOP = "var(--page-header-safe-top, max(48px, env(safe-area-inset-top, 48px)))";

const TITLEBAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginTop: SAFE_TOP,
  padding: "10px 14px",
  /* 去 backdrop-filter：P60 WebView 上磨砂在开屏动画期间会和外层重采样、导致掉帧画不全，
     浅色顶栏用近不透明渐变即可，视觉不变。 */
  background: "linear-gradient(180deg, rgba(255,255,255,.97), rgba(214,229,248,.94))",
  borderBottom: "1px solid rgba(140,180,220,.45)",
  color: "#2c4a6e",
  fontWeight: 600,
  fontSize: 15,
};

const GLASS_BTN: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,.75)",
  background: "rgba(255,255,255,.95)",
  boxShadow: "0 2px 8px rgba(23,23,28,.06)",
  color: "#2c4a6e",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 18,
  lineHeight: 1,
  flexShrink: 0,
};

const BODY: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "12px 14px 18px",
  background: "linear-gradient(180deg, rgba(236,244,255,.92), rgba(248,251,255,.96))",
};

export function HuaweiBridgeApp({ onClose, onNotice }: {
  onClose: () => void;
  onNotice?: (text: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  /* 返回：按钮先渐隐缩小，再真正卸载（与 reality-bridge 同构） */
  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 200);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderRadius: 16,
        overflow: "hidden",
        border: "1px solid rgba(150,190,230,.5)",
        boxShadow: "0 10px 32px rgba(90,130,180,.25)",
        background: "#eef5ff",
      }}
    >
      <div style={TITLEBAR}>
        <button type="button" onClick={handleClose} aria-label="返回桌面" style={{
          ...GLASS_BTN,
          pointerEvents: "auto",
          zIndex: 10,
          opacity: closing ? 0 : 1,
          transform: closing ? "scale(0.78)" : "none",
          transition: "opacity .2s ease, transform .2s ease",
        }}>
          ‹
        </button>
        <span style={{ flex: 1, textAlign: "center" }}>华为现实桥</span>
        <button
          type="button"
          style={{ ...GLASS_BTN, fontSize: 16, letterSpacing: 1, pointerEvents: "auto", zIndex: 10 }}
          onClick={() => setMenuOpen(v => !v)}
          aria-label="桥接设置"
        >
          ⋯
        </button>
      </div>

      <div style={BODY}>
        <HuaweiBridgeWizard />

        {menuOpen && (
          <div style={{ marginTop: 18, borderTop: "1px solid rgba(140,180,220,.3)", paddingTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#5a7a9e", marginBottom: 10 }}>
              桥接设置
            </div>
            <HuaweiShellSettings onNotice={onNotice} />
          </div>
        )}
      </div>
    </div>
  );
}
