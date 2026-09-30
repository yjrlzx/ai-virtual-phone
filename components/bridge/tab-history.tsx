"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CARD,
  BTN_GHOST,
  INK,
  SUB,
  FAINT,
  GREEN,
  RED,
  fmtTime,
  EmptyState,
} from "./shared";
import type { BridgeTabProps } from "./shared";
import {
  loadHuaweiBridgeEvents,
  clearHuaweiBridgeEvents,
} from "@/lib/huawei-shell/storage";
import type { HuaweiBridgeEvent } from "@/lib/huawei-shell/types";

/**
 * 运行日志 Tab（设置 → 运行日志）：
 *  规则命中 / 动作执行 / 主动查询 的逐条事件日志，全部来自 kv，最新在前。
 *  不写死演示数据。
 */

const KIND_ICON: Record<HuaweiBridgeEvent["kind"], string> = {
  rule: "⚡",
  action: "🔧",
  query: "📊",
};

export function TabHistory({ onNotice }: BridgeTabProps) {
  const [events, setEvents] = useState<HuaweiBridgeEvent[]>([]);

  const refresh = useCallback(() => {
    setEvents(loadHuaweiBridgeEvents(100));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clearAll = () => {
    clearHuaweiBridgeEvents();
    setEvents([]);
    onNotice?.("已清空运行记录");
  };

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 顶部：计数 + 操作 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "4px 2px 12px" }}>
        <span style={{ fontSize: 12.5, color: SUB }}>共 {events.length} 条记录</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" style={{ ...BTN_GHOST, padding: "5px 12px" }} onClick={refresh}>刷新</button>
          <button type="button" style={{ ...BTN_GHOST, padding: "5px 12px" }} onClick={clearAll}>清空</button>
        </div>
      </div>

      {events.length === 0 ? (
        <EmptyState
          title="还没有运行记录"
          desc="规则触发、动作执行、主动查询都会记在这里。"
          actionLabel="刷新"
          onAction={refresh}
        />
      ) : (
        events.map(ev => (
          <div key={ev.id} style={{ ...CARD, marginBottom: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{KIND_ICON[ev.kind]}</span>
              <b style={{
                flex: 1, minWidth: 0, fontSize: 13, color: INK,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {ev.title}
              </b>
              <span style={{ color: ev.ok ? GREEN : RED, fontWeight: 800, flexShrink: 0 }}>
                {ev.ok ? "✓" : "✗"}
              </span>
              <span style={{ fontSize: 11, color: FAINT, flexShrink: 0 }}>{fmtTime(ev.ts)}</span>
            </div>
            {ev.detail ? (
              <div style={{ fontSize: 11.5, color: FAINT, marginTop: 5, lineHeight: 1.6, wordBreak: "break-all" }}>
                {ev.detail}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
