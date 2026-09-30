"use client";

// 掌心窗（/chat-float）独立 WebView 的路由级 ErrorBoundary。
// 任何渲染期异常都会被这里捕获，显示一个带重试按钮的友好降级页，
// 而不是 Next.js 生产版的 "Application error: a client-side exception" 白屏。

export default function ChatFloatError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <div
            style={{
                position: "fixed", inset: 0, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 14, padding: 24,
                background: "var(--c-page-body-bg, #f8f7f2)", color: "var(--c-text, #222)",
                textAlign: "center", fontSize: 14,
            }}
        >
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>对话窗加载遇到问题</p>
            <p style={{ margin: 0, opacity: 0.65, fontSize: 13, lineHeight: 1.6, maxWidth: 320 }}>
                内容本身没有丢。点下面的按钮重新加载一次即可恢复。
            </p>
            <button
                type="button"
                onClick={() => reset()}
                style={{
                    marginTop: 4, padding: "10px 28px", borderRadius: 20, border: "none",
                    background: "var(--c-icon-active, #4f8cff)", color: "#fff",
                    fontSize: 14, cursor: "pointer",
                }}
            >
                重新加载
            </button>
            {error?.digest ? (
                <p style={{ margin: 0, opacity: 0.35, fontSize: 11 }}>错误标识：{error.digest}</p>
            ) : null}
        </div>
    );
}
