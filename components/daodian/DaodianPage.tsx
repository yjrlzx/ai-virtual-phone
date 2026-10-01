"use client";

import { useState } from "react";
import { kvGet, kvSet } from "@/lib/kv-db";

const CATEGORY_EMOJI: Record<string, string> = {
  "餐饮": "🍜", "交通": "🚇", "购物": "🛍️", "住房": "🏠", "娱乐": "🎮",
  "医疗": "💊", "学习": "📚", "其他": "📦",
};

function guessEmoji(note: string) {
  if (/饭|吃|餐|奶茶|咖啡/.test(note)) return CATEGORY_EMOJI["餐饮"];
  if (/地铁|公交|打车|滴滴/.test(note)) return CATEGORY_EMOJI["交通"];
  if (/淘宝|京东|买|衣服/.test(note)) return CATEGORY_EMOJI["购物"];
  if (/房租|水电/.test(note)) return CATEGORY_EMOJI["住房"];
  return CATEGORY_EMOJI["其他"];
}

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

  return (
    <div style={{ padding: "20px 16px 100px", maxWidth: 480, margin: "0 auto" }}>
      {/* 顶部总支出 */}
      <div style={{ padding: 24, background: "linear-gradient(135deg,#667eea,#764ba2)", borderRadius: 20, color: "#fff", marginBottom: 20 }}>
        <div style={{ fontSize: 13, opacity: 0.8 }}>本月总支出</div>
        <div style={{ fontSize: 36, fontWeight: 700, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>¥{total.toFixed(2)}</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>{ledger.length} 笔记录</div>
      </div>

      {/* 今日提醒 */}
      <section style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, paddingLeft: 4 }}>今日提醒</div>
        <div style={{ background: "#fff", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.06)", overflow: "hidden" }}>
          {reminders.filter((r: any) => r.at.startsWith(today)).length === 0 && (
            <div style={{ padding: 20, color: "#999", fontSize: 14, textAlign: "center" }}>今天没有提醒</div>
          )}
          {reminders.filter((r: any) => r.at.startsWith(today)).map((r: any, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ fontSize: 18, fontWeight: 600, color: "#667eea", minWidth: 44, fontVariantNumeric: "tabular-nums" }}>{r.at.slice(11,16)}</div>
              <div style={{ flex: 1, fontSize: 15 }}>{r.text}</div>
              <div style={{ fontSize: 18 }}>○</div>
            </div>
          ))}
        </div>
      </section>

      {/* 账单列表 */}
      <section>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, paddingLeft: 4 }}>支出明细</div>
        <div style={{ background: "#fff", borderRadius: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.06)", overflow: "hidden" }}>
          {ledger.length === 0 && (
            <div style={{ padding: 20, color: "#999", fontSize: 14, textAlign: "center" }}>还没有记录</div>
          )}
          {ledger.slice().reverse().map((r: any, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ fontSize: 24 }}>{guessEmoji(r.note)}</div>
              <div style={{ flex: 1, fontSize: 15 }}>{r.note || "支出"}</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#ff6b6b" }}>-¥{r.amount}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 底部按钮 */}
      <div style={{ position: "fixed", bottom: 20, left: 16, right: 16, maxWidth: 448, margin: "0 auto", display: "flex", gap: 12 }}>
        <button onClick={() => {
          const text = prompt("提醒内容？");
          const at = prompt("时间（ISO，如2026-10-08T15:00）？");
          if (text && at) { kvSet(`reminder_${Date.now()}`, JSON.stringify({ text, at, done: false })); force(n=>n+1); }
        }} style={{ flex: 1, minHeight: 56, borderRadius: 28, border: "none", background: "#4f8cff", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 12px rgba(79,140,255,0.3)" }}>加提醒</button>
        <button onClick={() => {
          const amount = parseFloat(prompt("金额？") || "0");
          const note = prompt("备注？") || "";
          if (amount > 0) {
            const list = JSON.parse(kvGet(`ledger_${month}`) || "[]");
            list.push({ amount, note, ts: Date.now() });
            kvSet(`ledger_${month}`, JSON.stringify(list));
            force(n=>n+1);
          }
        }} style={{ flex: 1, minHeight: 56, borderRadius: 28, border: "none", background: "#2ecc71", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer", boxShadow: "0 4px 12px rgba(46,204,113,0.3)" }}>记一笔</button>
      </div>
    </div>
  );
}
