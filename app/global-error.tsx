"use client";

// 全局 ErrorBoundary：兜住根 layout 或任意页面在客户端 hydration/render 阶段抛出的
// 未捕获异常（连路由级 error.tsx 都接不到的情况，比如 layout provider 崩了）。
// 必须自己渲染 <html>/<body>，因为它替换了整个根布局。

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <html lang="zh-CN">
            <body style={{
                margin: 0, minHeight: "100vh", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 14, padding: 24,
                background: "#f8f7f2", color: "#222", textAlign: "center", fontFamily: "system-ui, sans-serif",
            }}>
                <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>页面加载遇到问题</p>
                <p style={{ margin: 0, opacity: 0.65, fontSize: 13, lineHeight: 1.6, maxWidth: 320 }}>
                    点下面的按钮重新加载即可恢复。
                </p>
                <button
                    type="button"
                    onClick={() => reset()}
                    style={{
                        marginTop: 4, padding: "10px 28px", borderRadius: 20, border: "none",
                        background: "#4f8cff", color: "#fff", fontSize: 14, cursor: "pointer",
                    }}
                >
                    重新加载
                </button>
                {error?.digest ? (
                    <p style={{ margin: 0, opacity: 0.35, fontSize: 11 }}>错误标识：{error.digest}</p>
                ) : null}
            </body>
        </html>
    );
}
