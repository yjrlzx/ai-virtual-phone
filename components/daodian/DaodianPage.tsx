"use client";

import { useState } from "react";
import { kvGet, kvSet } from "@/lib/kv-db";

export function DaodianPage() {
  const [, force] = useState(0);
  const today = new Date().toISOString().slice(0,10);
  const month = today.slice(0,7);

  // 读提醒
  const reminders = Object.keys(localStorage)
    .filter(k => k.startsWith("reminder_"))
    .map(k => { try { return JSON.parse(localStorage.getItem(k)!); } catch { return null; } })
    .filter(Boolean)
    .sort((a: any, b: any) => a.at.localeCompare(b.at));

  // 读账单
  const ledger = (() => { try { return JSON.parse(kvGet(`ledger_${month}`) || "[]"); } catch { return []; } })();
  const total = ledger.reduce((s: number, r: any) => s + r.amount, 0);

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <h2 style={{ fontSize: 20, marginBottom: 16 }}>到点</h2>

      <b style={{ fontSize: 14 }}>今日提醒</b>
      <div style={{ marginTop: 8, marginBottom: 16 }}>
        {reminders.filter((r: any) => r.at.startsWith(today)).length === 0 && <div style={{ color: "#999", fontSize: 13 }}>今天没有提醒</div>}
        {reminders.filter((r: any) => r.at.startsWith(today)).map((r: any, i: number) => (
          <div key={i} style={{ padding: 10, background: "#f5f5f5", borderRadius: 8, marginBottom: 6, fontSize: 14 }}>
            {r.at.slice(11,16)} {r.text}
          </div>
        ))}
      </div>

      <b style={{ fontSize: 14 }}>本月账单</b>
      <div style={{ marginTop: 8 }}>
        {ledger.length === 0 && <div style={{ color: "#999", fontSize: 13 }}>还没记账</div>}
        {ledger.map((r: any, i: number) => (
          <div key={i} style={{ padding: 8, borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", fontSize: 14 }}>
            <span>{r.note || "支出"}</span>
            <span>¥{r.amount}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, padding: 12, background: "#f5f5f5", borderRadius: 8, fontSize: 14 }}>
        本月合计：<b>¥{total.toFixed(2)}</b>（{ledger.length} 笔）
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={() => {
          const text = prompt("提醒内容？");
          const at = prompt("时间（ISO，如2026-10-08T15:00）？");
          if (text && at) { kvSet(`reminder_${Date.now()}`, JSON.stringify({ text, at, done: false })); force(n=>n+1); }
        }} style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "none", background: "#4f8cff", color: "#fff", fontSize: 15, cursor: "pointer" }}>加提醒</button>
        <button onClick={() => {
          const amount = parseFloat(prompt("金额？") || "0");
          const note = prompt("备注？") || "";
          if (amount > 0) {
            const list = JSON.parse(kvGet(`ledger_${month}`) || "[]");
            list.push({ amount, note, ts: Date.now() });
            kvSet(`ledger_${month}`, JSON.stringify(list));
            force(n=>n+1);
          }
        }} style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "none", background: "#ff6b6b", color: "#fff", fontSize: 15, cursor: "pointer" }}>记一笔</button>
      </div>
    </div>
  );
}
