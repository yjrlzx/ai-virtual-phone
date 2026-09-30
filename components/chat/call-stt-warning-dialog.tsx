"use client";

import { createPortal } from "react-dom";

const CALL_STT_WARNING_HIDDEN_KEY = "ai_phone_call_stt_warning_hidden_v1";

export function isCallSttWarningHidden(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(CALL_STT_WARNING_HIDDEN_KEY) === "1";
    } catch {
        return false;
    }
}

export function hideCallSttWarningPermanently() {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(CALL_STT_WARNING_HIDDEN_KEY, "1");
    } catch {
        // Ignore storage failures; the prompt can still be closed for this session.
    }
}

type CallSttWarningDialogProps = {
    title?: string;
    message?: string;
    onClose: () => void;
    onNeverShow: () => void;
};

export function CallSttWarningDialog({
    title = "语音识别提示",
    message = "未检测到可识别的语音，可能当前浏览器不支持语音识别、系统麦克风权限未开启，或麦克风没有输入，可点击中间麦克风按钮切换到文字输入模式以继续通话。",
    onClose,
    onNeverShow,
}: CallSttWarningDialogProps) {
    const overlayStyle: React.CSSProperties = {
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 100000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
        padding: 16,
    };
    const dialogStyle: React.CSSProperties = {
        width: "90vw",
        maxWidth: 320,
        maxHeight: "80vh",
        overflowY: "auto",
        background: "var(--c-panel, #fff)",
        borderRadius: 16,
        padding: "20px",
        boxShadow: "0 12px 36px rgba(0,0,0,0.3)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        color: "var(--c-text, #222)",
    };
    const footerStyle: React.CSSProperties = {
        display: "flex",
        gap: 10,
        justifyContent: "center",
        flexWrap: "wrap",
    };
    const btnStyle: React.CSSProperties = {
        minHeight: 44,
        minWidth: 88,
        padding: "10px 18px",
        borderRadius: 22,
        border: "none",
        fontSize: 14,
        cursor: "pointer",
    };

    const content = (
        <div style={overlayStyle} onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                onClick={event => event.stopPropagation()}
                style={dialogStyle}
            >
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, textAlign: "center" }}>{title}</h3>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, textAlign: "center" }}>{message}</p>
                <div style={footerStyle}>
                    <button type="button" style={{ ...btnStyle, background: "var(--c-soft, #f0f0f0)", color: "var(--c-text, #333)" }} onClick={onClose}>我知道了</button>
                    <button type="button" style={{ ...btnStyle, background: "var(--c-icon-active, #4f8cff)", color: "#fff" }} onClick={onNeverShow}>以后不再提示</button>
                </div>
            </div>
        </div>
    );

    if (typeof document === "undefined") return null;
    return createPortal(content, document.body);
}
