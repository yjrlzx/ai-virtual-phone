"use client";

import { useState } from "react";
import { kvGet, kvSet } from "@/lib/kv-db";

export function DaodianPage() {
  const [, force] = useState(0);
  const today = new Date().toISOString().slice(0,10);
  const month = today.slice(0,7);

  const reminders = Object.keys(localStorage)
    .filter(k => k.startsWith("reminder_"))
    .map(k => { try { return { ...JSON.parse(localStorage.getItem(k)!), _k: k }; } catch { return null; } })
    .filter(Boolean)
    .sort((a: any, b: any) => a.at.localeCompare(b.at));

  const ledger = (() => { try { return JSON.parse(kvGet(`ledger_${month}`) || "[]"); } catch { return []; } })();
  const total = ledger.reduce((s: number, r: any) => s + r.amount, 0);

  // 待取快递
  const packages = (() => { try { return JSON.parse(kvGet("packages") || "[]"); } catch { return []; } })();

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto", paddingBottom: 100 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>到点</h2>

      {/* 待取快递 */}
      {packages.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <b style={{ fontSize: 15 }}>📦 待取快递</b>
          {packages.map((p: any, i: number) => (
            <div key={i} style={{ marginTop: 8, padding: 12, background: "#fff7e6", borderRadius: 12, fontSize: 14 }}>
              <div>取件码：<b>{p.code}</b></div>
              <div style={{ color: "#999", fontSize: 12, marginTop: 4 }}>{p.carrier || ""} · {p.time || ""}</div>
            </div>
          ))}
        </section>
      )}

      {/* 今日提醒 */}
      <section style={{ marginBottom: 24 }}>
        <b style={{ fontSize: 15 }}>⏰ 今日提醒</b>
        <div style={{ marginTop: 8 }}>
          {reminders.filter((r: any) => r.at.startsWith(today)).length === 0 && <div style={{ color: "#999", fontSize: 14, padding: 12 }}>今天没有提醒</div>}
          {reminders.filter((r: any) => r.at.startsWith(today)).map((r: any, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: "#f5f5f5", borderRadius: 12, marginBottom: 8 }}>
              <div style={{ fontSize: 20 }}>🔔</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{r.at.slice(11,16)}</div>
                <div style={{ fontSize: 14, color: "#666" }}>{r.text}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 本月账单 */}
      <section style={{ marginBottom: 24 }}>
        <b style={{ fontSize: 15 }}>💰 本月账单</b>
        <div style={{ marginTop: 8, padding: 16, background: "#f5f5f5", borderRadius: 12 }}>
          <div style={{ fontSize: 13, color: "#999" }}>本月合计</div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>¥{total.toFixed(2)}</div>
          <div style={{ fontSize: 12, color: "#999", marginTop: 4 }}>{ledger.length} 笔支出</div>
        </div>
        <div style={{ marginTop: 8 }}>
          {ledger.length === 0 && <div style={{ color: "#999", fontSize: 14, padding: 12 }}>还没记账</div>}
          {ledger.slice().reverse().map((r: any, i: number) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: 12, borderBottom: "1px solid #eee", fontSize: 15 }}>
              <span>{r.note || "支出"}</span>
              <span style={{ fontWeight: 600 }}>¥{r.amount}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 底部按钮 */}
      <div style={{ position: "fixed", bottom: 16, left: 16, right: 16, maxWidth: 448, display: "flex", gap: 12 }}>
        <button onClick={() => {
          const text = prompt("提醒内容？");
          const at = prompt("时间（ISO，如2026-10-08T15:00）？");
          if (text && at) { kvSet(`reminder_${Date.now()}`, JSON.stringify({ text, at, done: false })); force(n=>n+1); }
        }} style={{ flex: 1, minHeight: 52, borderRadius: 14, border: "none", background: "#4f8cff", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" }}>➕ 加提醒</button>
        <button onClick={() => {
          const amount = parseFloat(prompt("金额？") || "0");
          const note = prompt("备注？") || "";
          if (amount > 0) {
            const list = JSON.parse(kvGet(`ledger_${month}`) || "[]");
            list.push({ amount, note, ts: Date.now() });
            kvSet(`ledger_${month}`, JSON.stringify(list));
            force(n=>n+1);
          }
        }} style={{ flex: 1, minHeight: 52, borderRadius: 14, border: "none", background: "#ff6b6b", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" }}>✏️ 记一笔</button>
      </div>
    </div>
  );
}
