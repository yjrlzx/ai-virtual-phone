import type { CSSProperties } from "react";
import { HuaweiShellSettings } from "./huawei-shell-settings";

/**
 * 华为现实桥 —— float 桌面独立 App 入口。
 *
 * 把原本藏在设置里的「华为壳·真实手机桥」配置页，升级成 float 桌面上的
 * 一个正式 App：有自己的标题栏、窗口点、关闭按钮和滚动内容区。
 * 内部直接渲染 HuaweiShellSettings 的全部配置能力（权限 / 门禁 / 天气 /
 * 记账 / 快捷动作 / 健康 / 陪伴 / 快速测试），不改动其原有逻辑。
 *
 * 只做增量：不动 float 壳、素材集市、内置 AI 对话与 char 主流程。
 */

const HB_TITLEBAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderRadius: "14px 14px 0 0",
  background: "linear-gradient(180deg, rgba(255,255,255,.85), rgba(214,229,248,.55))",
  borderBottom: "1px solid rgba(140,180,220,.45)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  color: "#2c4a6e",
  fontWeight: 600,
  fontSize: 15,
};

const HB_DOTS: CSSProperties = {
  display: "flex",
  gap: 6,
  marginRight: 2,
};

const HB_DOT: CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: "#f2b8b8",
  boxShadow: "inset 0 0 0 1px rgba(120,60,60,.15)",
};

const HB_BODY: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 14,
  background:
    "linear-gradient(180deg, rgba(236,244,255,.92), rgba(248,251,255,.96))",
};

export function HuaweiBridgeApp({ onClose, onNotice }: {
  onClose: () => void;
  onNotice?: (text: string) => void;
}) {
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
      <div style={HB_TITLEBAR}>
        <span style={HB_DOTS}>
          <i style={HB_DOT} />
          <i style={{ ...HB_DOT, background: "#f6d9a8" }} />
          <i style={{ ...HB_DOT, background: "#b7e0b7" }} />
        </span>
        <span>华为现实桥</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          style={{
            border: "none",
            background: "rgba(140,175,215,.25)",
            color: "#2c4a6e",
            borderRadius: 8,
            width: 26,
            height: 26,
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={HB_BODY}>
        <HuaweiShellSettings onNotice={onNotice} />
      </div>
    </div>
  );
}
