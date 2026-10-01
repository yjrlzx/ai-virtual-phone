"use client";

import { useState, useEffect } from "react";
import { kvGet, kvSet } from "@/lib/kv-db";

const TAGS = ["开心","平静","烦躁","难过","焦虑","累","委屈","想他","饿","困","生气","想家","迷茫","充实","轻松","紧张","害羞","得意","emo","还好"];

function Page({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg, #fff)", zIndex: 9999, overflowY: "auto", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} style={{ minHeight: 44, minWidth: 44, border: "none", background: "none", fontSize: 20, cursor: "pointer" }}>←</button>
        <b style={{ fontSize: 18 }}>{title}</b>
      </div>
      {children}
    </div>
  );
}

export function LifestyleHome({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<string | null>(null);
  if (page) return <LifestylePages page={page} onBack={() => setPage(null)} />;
  const items = [
    ["mood-diary", "情绪日记", "选今天的心情"],
    ["water", "喝水", "记录今天喝了几杯"],
    ["period", "经期", "记录周期"],
    ["note", "锁屏纸条", "编辑今天的话"],
    ["todo", "我们的清单", "共享待办"],
    ["pomodoro", "番茄钟", "25分钟专注"],
  ] as const;
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onClose} style={{ minHeight: 44, minWidth: 44, border: "none", background: "none", fontSize: 20 }}>←</button>
        <b style={{ fontSize: 18 }}>生活助手</b>
      </div>
      {items.map(([key, label, desc]) => (
        <div key={key} onClick={() => setPage(key)} style={{ padding: 14, borderBottom: "1px solid #eee", cursor: "pointer", minHeight: 44 }}>
          <div style={{ fontSize: 15 }}>{label}</div>
          <div style={{ fontSize: 12, color: "#999" }}>{desc}</div>
        </div>
      ))}
    </div>
  );
}

export function LifestylePages({ page, onBack }: { page: string; onBack: () => void }) {
  const today = new Date().toISOString().slice(0,10);
  const [, force] = useState(0);

  if (page === "mood-diary") {
    const current = (() => { try { return JSON.parse(kvGet(`mood_diary_${today}`) || '{"tags":[]}'); } catch { return { tags: [] }; } })();
    return (
      <Page title="情绪日记" onBack={onBack}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {TAGS.map(t => {
            const active = current.tags.includes(t);
            return (
              <button key={t} style={{ padding: "12px 16px", minHeight: 44, borderRadius: 999, border: active ? "2px solid #ff6b6b" : "1px solid #ccc", background: active ? "#ff6b6b22" : "transparent", cursor: "pointer", fontSize: 14 }}
                onClick={() => {
                  const tags = active ? current.tags.filter((x: string) => x !== t) : [...current.tags, t];
                  kvSet(`mood_diary_${today}`, JSON.stringify({ tags, ts: Date.now() }));
                  force(n => n+1);
                }}>{t}</button>
            );
          })}
        </div>
      </Page>
    );
  }

  if (page === "water") {
    const cups = parseInt(kvGet(`water_count_${today}`) || "0");
    return (
      <Page title="喝水" onBack={onBack}>
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 80 }}>💧</div>
          <div style={{ fontSize: 32, fontWeight: 700, margin: "16px 0" }}>{cups} 杯</div>
          <button onClick={() => { kvSet(`water_count_${today}`, String(cups+1)); force(n=>n+1); }}
            style={{ minHeight: 48, padding: "12px 32px", borderRadius: 12, border: "none", background: "#4ecdc4", color: "#fff", fontSize: 16, cursor: "pointer" }}>喝了一杯</button>
        </div>
      </Page>
    );
  }

  if (page === "period") {
    const last = kvGet("period_last_date") || "";
    return (
      <Page title="经期" onBack={onBack}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>上次开始：{last || "未设置"}</div>
        <input type="date" defaultValue={last} onChange={e => kvSet("period_last_date", e.target.value)} style={{ width: "100%", padding: 12, minHeight: 44, borderRadius: 8, border: "1px solid #ccc" }} />
      </Page>
    );
  }

  if (page === "note") {
    const note = kvGet("locker_note") || "";
    return (
      <Page title="锁屏纸条" onBack={onBack}>
        <textarea defaultValue={note} onChange={e => kvSet("locker_note", e.target.value)} style={{ width: "100%", minHeight: 120, padding: 12, borderRadius: 8, border: "1px solid #ccc" }} placeholder="写一句..." />
      </Page>
    );
  }

  if (page === "todo") {
    const items = (() => { try { return JSON.parse(kvGet("shared_todo") || "[]"); } catch { return []; } })();
    return (
      <Page title="我们的清单" onBack={onBack}>
        {items.map((t: string, i: number) => (
          <div key={i} style={{ padding: 12, borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between" }}>
            <span>{t}</span>
            <button onClick={() => { kvSet("shared_todo", JSON.stringify(items.filter((_: string, j: number) => j !== i))); force(n=>n+1); }}>×</button>
          </div>
        ))}
        <input placeholder="加一项..." onKeyDown={e => {
          if (e.key === "Enter" && (e.target as HTMLInputElement).value) {
            kvSet("shared_todo", JSON.stringify([...items, (e.target as HTMLInputElement).value]));
            (e.target as HTMLInputElement).value = "";
            force(n=>n+1);
          }
        }} style={{ width: "100%", padding: 12, minHeight: 44, borderRadius: 8, border: "1px solid #ccc", marginTop: 8 }} />
      </Page>
    );
  }

  if (page === "pomodoro") {
    const [sec, setSec] = useState(25*60);
    const [running, setRunning] = useState(false);
    useEffect(() => {
      if (!running) return;
      const t = setInterval(() => setSec(s => s <= 1 ? (setRunning(false), 0) : s-1), 1000);
      return () => clearInterval(t);
    }, [running]);
    return (
      <Page title="番茄钟" onBack={onBack}>
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 56, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{Math.floor(sec/60)}:{String(sec%60).padStart(2,"0")}</div>
          <button onClick={() => setRunning(!running)} style={{ minHeight: 48, marginTop: 24, padding: "12px 32px", borderRadius: 12, border: "none", background: running ? "#ff6b6b" : "#4f8cff", color: "#fff", fontSize: 16, cursor: "pointer" }}>{running ? "暂停" : "开始"}</button>
        </div>
      </Page>
    );
  }

  return null;
}
