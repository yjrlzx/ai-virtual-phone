"use client";

// 客户端 ErrorBoundary：直接包在 /chat-float 页面内容外层。
// Next.js 的路由级 error.tsx 在初次 hydration 尚未完成时接不到异常，
// 这里用 class component 自己兜，保证 WebView 里任何渲染期异常都显示友好降级页。

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean; errorMsg: string };

export class ChatFloatErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false, errorMsg: "" };

    static getDerivedStateFromError(error: unknown): State {
        const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return { hasError: true, errorMsg: msg };
    }

    componentDidCatch(error: unknown, info: React.ErrorInfo) {
        console.error("[ChatFloat] render error:", error, info);
    }

    render() {
        if (this.state.hasError) {
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
                    <pre style={{
                        margin: 0, maxWidth: 360, fontSize: 11, lineHeight: 1.5,
                        whiteSpace: "pre-wrap", wordBreak: "break-all", opacity: 0.7,
                        textAlign: "left", fontFamily: "monospace",
                        background: "rgba(0,0,0,.05)", padding: 8, borderRadius: 8,
                    }}>{this.state.errorMsg}</pre>
                    <button
                        type="button"
                        onClick={() => {
                            this.setState({ hasError: false });
                            if (typeof window !== "undefined") window.location.reload();
                        }}
                        style={{
                            marginTop: 4, padding: "10px 28px", borderRadius: 20, border: "none",
                            background: "var(--c-icon-active, #4f8cff)", color: "#fff",
                            fontSize: 14, cursor: "pointer",
                        }}
                    >
                        重新加载
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
