import type { CSSProperties } from "react";

/**
 * Lifeline —— float 桌面独立 App 入口。
 *
 * 把原本以自定义应用包形式分发的 Lifeline（每日记录 / 学习进度 / 饮食 / 体重 / 财务）
 * 升级成 float 桌面上的一个正式 App：有自己的标题栏、窗口点、关闭按钮和滚动内容区。
 * 内部直接 iframe 挂载 build/dist-lifeline 的 index.html，数据仍走 float 本地存储。
 *
 * 只做增量：不动 float 壳、素材集市、内置 AI 对话与 char 主流程。
 */

const LB_TITLEBAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderRadius: "14px 14px 0 0",
  background: "linear-gradient(180deg, rgba(255,255,255,.85), rgba(224,236,250,.55))",
  borderBottom: "1px solid rgba(150,190,225,.45)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  color: "#2c4a6e",
  fontWeight: 600,
  fontSize: 15,
};

const LB_DOTS: CSSProperties = {
  display: "flex",
  gap: 6,
  marginRight: 2,
};

const LB_DOT: CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: "#f2b8b8",
  boxShadow: "inset 0 0 0 1px rgba(120,60,60,.15)",
};

const LB_BODY: CSSProperties = {
  flex: 1,
  overflow: "hidden",
  background: "#f4f8ff",
};

export function LifelineApp({ onClose }: {
  onClose: () => void;
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
      <div style={LB_TITLEBAR}>
        <span style={LB_DOTS}>
          <i style={LB_DOT} />
          <i style={{ ...LB_DOT, background: "#f6d9a8" }} />
          <i style={{ ...LB_DOT, background: "#b7e0b7" }} />
        </span>
        <span>Lifeline</span>
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
      <div style={LB_BODY}>
        <iframe
          src="/lifeline/index.html"
          title="Lifeline"
          style={{ width: "100%", height: "100%", border: "none", background: "#f4f8ff" }}
        />
      </div>
    </div>
  );
}
