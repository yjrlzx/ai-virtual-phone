"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAndroidShell,
  readLockedPackagesFromShell,
  pushLockedPackagesToShell,
  parseShellJson,
} from "@/lib/huawei-shell/storage";
import type { HuaweiInstalledApp } from "@/lib/huawei-shell/types";
import {
  CARD,
  BTN_GHOST,
  INPUT,
  GUIDE_BOX,
  INK,
  FAINT,
  Badge,
  Switch,
  EmptyState,
  type BridgeTabProps,
} from "./shared";

/**
 * 锁应用 Tab：把选定 App 加入门禁锁（打开需验证）。
 * 应用列表来自 shell.getInstalledApps() 真实返回；当前锁列表来自
 * readLockedPackagesFromShell()；每次切换整表 pushLockedPackagesToShell 下发，
 * 成功才更新 state，失败 onNotice 报错并保持原列表（回滚）。绝不写死任何应用。
 */

type InstalledAppsResult = {
  ok: boolean;
  count?: number;
  apps?: HuaweiInstalledApp[];
  error?: string;
};

export function TabLock({ onNotice }: BridgeTabProps) {
  const [apps, setApps] = useState<HuaweiInstalledApp[]>([]);
  const [lockedList, setLockedList] = useState<string[]>(() => readLockedPackagesFromShell());
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busyPkg, setBusyPkg] = useState<string | null>(null);
  const [shellConnected, setShellConnected] = useState<boolean>(() => getAndroidShell() !== null);

  const refresh = useCallback(() => {
    const shell = getAndroidShell();
    setShellConnected(shell !== null);
    if (!shell?.getInstalledApps) {
      onNotice?.("安卓壳未连接或不支持列出应用");
      return;
    }
    setRefreshing(true);
    try {
      const parsed = parseShellJson<InstalledAppsResult>(shell.getInstalledApps());
      if (parsed?.ok && Array.isArray(parsed.apps)) {
        setApps(parsed.apps);
        // 壳里可能已被其他端改过，刷新时重新读一次真实锁列表
        setLockedList(readLockedPackagesFromShell());
        onNotice?.(`已加载 ${parsed.apps.length} 个应用`);
      } else {
        onNotice?.(`加载失败：${parsed?.error ?? "未知错误"}`);
      }
    } catch (e) {
      onNotice?.(`加载失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRefreshing(false);
    }
  }, [onNotice]);

  useEffect(() => {
    setShellConnected(getAndroidShell() !== null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLock = (pkg: string, label?: string) => {
    if (busyPkg) return;
    const willLock = !lockedList.includes(pkg);
    const nextList = willLock
      ? [...lockedList, pkg]
      : lockedList.filter(p => p !== pkg);
    setBusyPkg(pkg);
    const r = pushLockedPackagesToShell(nextList);
    if (r.ok) {
      setLockedList(nextList);
      onNotice?.(willLock ? `已锁定 ${label ?? pkg}` : `已解锁 ${label ?? pkg}`);
    } else {
      onNotice?.(`操作失败：${r.error ?? "未知错误"}`);
    }
    setBusyPkg(null);
  };

  // 包名 → label 映射：顶部已锁 chips 里，若该包不在当前列表则退回显示包名
  const labelByPkg = new Map<string, string>(apps.map(a => [a.pkg, a.label]));

  const q = query.trim().toLowerCase();
  const filtered = q
    ? apps.filter(a => a.label.toLowerCase().includes(q) || a.pkg.toLowerCase().includes(q))
    : apps;

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 顶部状态 Badge：壳连接 + 已锁数量 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <Badge tone={shellConnected ? "ok" : "gray"} text={shellConnected ? "壳已连接" : "壳未连接"} />
        <Badge tone="amber" text={`已锁 ${lockedList.length} 个`} />
      </div>

      {/* 工具条：搜索 + 刷新 */}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          style={{ ...INPUT, flex: 1 }}
          placeholder="搜索应用名 / 包名"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button type="button" style={BTN_GHOST} onClick={refresh} disabled={refreshing}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: FAINT, marginTop: 6 }}>
        共 {apps.length} 个应用 · 打开已锁定应用时需先通过门禁验证
      </div>

      {/* 已锁 App 快速移除 chips */}
      {lockedList.length > 0 ? (
        <div style={{ ...CARD, marginTop: 10 }}>
          <b style={{ fontSize: 13, color: INK }}>已锁定的应用</b>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {lockedList.map(pkg => (
              <span
                key={pkg}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  color: INK,
                  background: "rgba(217,83,79,.1)",
                  borderRadius: 999,
                  padding: "4px 10px",
                }}
              >
                <span>{labelByPkg.get(pkg) ?? pkg}</span>
                <button
                  type="button"
                  aria-label={`移除 ${pkg}`}
                  onClick={() => toggleLock(pkg, labelByPkg.get(pkg))}
                  disabled={busyPkg !== null}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#d9534f",
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* 应用列表：label + pkg + 右侧 Switch */}
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.length === 0 ? (
          <EmptyState
            title={apps.length === 0 ? "还没有应用列表" : "没有匹配的应用"}
            desc={apps.length === 0
              ? "点右上角「刷新」从手机拉取已安装应用列表。"
              : "换个关键词试试。"}
            actionLabel="刷新应用列表"
            onAction={refresh}
          />
        ) : null}

        {filtered.map(app => {
          const on = lockedList.includes(app.pkg);
          return (
            <div key={app.pkg} style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <b style={{ fontSize: 13.5, color: INK }}>{app.label}</b>
                    {app.isSystem ? <Badge tone="gray" text="系统应用" /> : null}
                  </div>
                  <div style={{ fontSize: 11, color: FAINT, marginTop: 3, wordBreak: "break-all" }}>
                    {app.pkg}
                  </div>
                </div>
                <Switch
                  on={on}
                  onChange={() => toggleLock(app.pkg, app.label)}
                  label={`锁定 ${app.label}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      {!shellConnected ? (
        <div style={{ ...GUIDE_BOX, marginTop: 12, marginBottom: 0 }}>
          安卓壳未连接：请在真机 WebView 中打开本页后点「刷新」拉取应用列表，才能配置门禁锁。
        </div>
      ) : null}
    </div>
  );
}
