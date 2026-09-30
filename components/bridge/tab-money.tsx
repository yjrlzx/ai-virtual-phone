"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CARD,
  BTN,
  BTN_GHOST,
  INK,
  SUB,
  FAINT,
  GREEN,
  EmptyState,
} from "./shared";
import type { BridgeTabProps } from "./shared";
import {
  syncHuaweiLedgerFromShell,
  readHuaweiLedger,
  getHuaweiLedgerSummary,
  isHuaweiShellAvailable,
} from "@/lib/huawei-shell/storage";
import type { HuaweiLedgerRecord } from "@/lib/huawei-shell/storage";
import type { PaymentSource } from "@/lib/huawei-shell/types";

/**
 * 记账 Tab（自动记账）：
 *  读取微信/支付宝支付通知弹窗，落账到与记账应用同一份账本。
 *  统计与列表全部来自 getHuaweiLedgerSummary / readHuaweiLedger（本地 kv，不依赖壳），
 *  同步动作才通过 window.AndroidShell 拉通知。绝不写死演示数据。
 */

const SOURCE_META: Record<HuaweiLedgerRecord["source"], { icon: string; label: string }> = {
  wechat: { icon: "💬", label: "微信" },
  alipay: { icon: "🅰️", label: "支付宝" },
  cash: { icon: "💵", label: "现金" },
  manual: { icon: "📝", label: "手动" },
};

const CHIPS: Array<{ value: PaymentSource; label: string }> = [
  { value: "all", label: "全部" },
  { value: "wechat", label: "微信" },
  { value: "alipay", label: "支付宝" },
];

type LedgerSummary = ReturnType<typeof getHuaweiLedgerSummary>;

export function TabMoney({ onNotice }: BridgeTabProps) {
  const [summary, setSummary] = useState<LedgerSummary>({ total: 0, wechat: 0, alipay: 0, other: 0, updatedAt: 0 });
  const [records, setRecords] = useState<HuaweiLedgerRecord[]>([]);
  const [source, setSource] = useState<PaymentSource>("all");
  const [shellConnected, setShellConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState("");

  const refresh = useCallback((src: PaymentSource) => {
    setSummary(getHuaweiLedgerSummary());
    setRecords(readHuaweiLedger(50, src));
    setShellConnected(isHuaweiShellAvailable());
  }, []);

  useEffect(() => {
    refresh("all");
  }, [refresh]);

  const switchSource = (src: PaymentSource) => {
    setSource(src);
    setRecords(readHuaweiLedger(50, src));
  };

  const handleSync = () => {
    if (syncing) return;
    setSyncing(true);
    const res = syncHuaweiLedgerFromShell(50);
    setSyncing(false);
    if (res.ok) {
      const text = res.added > 0 ? `本次新增 ${res.added} 笔，共 ${res.total} 笔` : `没有新账单，共 ${res.total} 笔`;
      setSyncResult(text);
      onNotice?.(text);
    } else {
      const text = res.error || "同步失败";
      setSyncResult(text);
      onNotice?.(text);
    }
    refresh(source);
  };

  const tiles = [
    { label: "总笔数", value: `${summary.total}`, color: INK },
    { label: "微信", value: `${summary.wechat}`, color: GREEN },
    { label: "支付宝", value: `${summary.alipay}`, color: "#1677ff" },
  ];

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 三个统计磁贴 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        {tiles.map(t => (
          <div key={t.label} style={{ ...CARD, padding: 16 }}>
            <i style={{ fontStyle: "normal", fontSize: 10.5, color: FAINT, display: "block" }}>{t.label}</i>
            <b style={{ display: "block", fontSize: 18, fontWeight: 800, marginTop: 6, color: t.color, fontVariantNumeric: "tabular-nums" }}>
              {t.value}
            </b>
          </div>
        ))}
      </div>

      {/* 同步支付通知 */}
      <div style={{ ...CARD, marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b style={{ fontSize: 13.5, fontWeight: 800, color: INK, display: "block" }}>同步支付通知</b>
            <span style={{ fontSize: 11.5, color: FAINT }}>读取最近支付通知弹窗自动记账（按来源+金额+商户+日期去重）</span>
          </div>
          <button
            type="button"
            style={{ ...BTN, flexShrink: 0, opacity: syncing ? 0.6 : 1 }}
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? "同步中…" : "同步"}
          </button>
        </div>
        {!shellConnected ? (
          <div style={{ fontSize: 11.5, color: "#c8902e", marginTop: 8, lineHeight: 1.6 }}>
            当前未连接华为壳，仅展示本地账本；同步需在华为壳 App 内打开本站。
          </div>
        ) : null}
        {syncResult ? (
          <div style={{ fontSize: 11.5, color: SUB, marginTop: 8, lineHeight: 1.6 }}>{syncResult}</div>
        ) : null}
      </div>

      {/* 来源筛选 */}
      <div style={{ display: "flex", gap: 8, margin: "14px 2px 10px" }}>
        {CHIPS.map(chip => (
          <button
            key={chip.value}
            type="button"
            onClick={() => switchSource(chip.value)}
            style={{
              ...(source === chip.value ? BTN : BTN_GHOST),
              padding: "5px 14px",
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* 最近账单 */}
      {records.length === 0 ? (
        <div style={{ ...CARD }}>
          <EmptyState
            title="还没有账单"
            desc="点上方同步按钮，从微信/支付宝支付通知自动记账。"
            actionLabel="同步支付通知"
            onAction={handleSync}
          />
        </div>
      ) : (
        records.map(rec => (
          <div key={rec.id} style={{ ...CARD, marginBottom: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{SOURCE_META[rec.source].icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {rec.merchant || rec.note || "未命名交易"}
                </div>
                <div style={{ fontSize: 11, color: FAINT, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {SOURCE_META[rec.source].label}{rec.note ? ` · ${rec.note}` : ""}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <b style={{ fontSize: 14, color: INK, fontVariantNumeric: "tabular-nums" }}>¥{rec.amount.toFixed(2)}</b>
                <div style={{ fontSize: 10.5, color: FAINT }}>{rec.date}</div>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
