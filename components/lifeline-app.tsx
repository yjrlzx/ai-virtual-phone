import { useState, useEffect, useRef, type CSSProperties } from "react";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { resolveCallAvatar } from "@/lib/call-settings";

/**
 * Lifeline —— float 桌面独立 App 入口。
 */

const SAFE_TOP = "var(--page-header-safe-top, max(48px, env(safe-area-inset-top, 48px)))";

const LB_TITLEBAR: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, marginTop: SAFE_TOP,
  padding: "10px 14px", borderRadius: "14px 14px 0 0",
  background: "linear-gradient(180deg, rgba(255,255,255,.97), rgba(224,236,250,.94))",
  borderBottom: "1px solid rgba(150,190,225,.45)",
  color: "#2c4a6e", fontWeight: 600, fontSize: 15,
};

const LB_DOTS: CSSProperties = { display: "flex", gap: 6, marginRight: 2 };
const LB_DOT: CSSProperties = {
  width: 12, height: 12, borderRadius: "50%", background: "#f2b8b8",
  boxShadow: "inset 0 0 0 1px rgba(120,60,60,.15)",
};

const LB_BODY: CSSProperties = { flex: 1, overflow: "hidden", background: "#f4f8ff" };

export function LifelineApp({ onClose }: { onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const sendAvatars = () => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    try {
      const chars = loadCharacters();
      const char = chars[0];
      const charAvatar = char ? resolveCallAvatar(char.id, char.avatar) : null;
      const ui = resolveUserIdentity(char?.id || "", "chat");
      iframe.contentWindow.postMessage({
        type: "lifeline:avatars",
        charAvatar: charAvatar || "",
        userAvatar: ui?.avatarUrl || "",
      }, "*");
    } catch { /* ignore */ }
  };

  useEffect(() => {
    const t = window.setTimeout(sendAvatars, 600);
    return () => window.clearTimeout(t);
  }, []);

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 200);
  };

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      borderRadius: 16, overflow: "hidden",
      border: "1px solid rgba(150,190,230,.5)",
      boxShadow: "0 10px 32px rgba(90,130,180,.25)",
      background: "#eef5ff",
    }}>
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
          onClick={handleClose}
          aria-label="返回桌面"
          style={{
            border: "none", background: "transparent", color: "#2c4a6e",
            cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 4,
            pointerEvents: "auto", zIndex: 10, opacity: closing ? 0 : 1,
            transform: closing ? "scale(0.78)" : "none",
            transition: "opacity .2s ease, transform .2s ease",
          }}
        >
          ←
        </button>
      </div>
      <div style={LB_BODY}>
        <iframe
          ref={iframeRef}
          src="/lifeline/index.html"
          title="Lifeline"
          onLoad={sendAvatars}
          style={{ width: "100%", height: "100%", border: "none", background: "#f4f8ff" }}
        />
      </div>
    </div>
  );
}
