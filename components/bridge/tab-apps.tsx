"use client";

import { useCallback, useEffect, useState } from "react";
import { getAndroidShell } from "@/lib/huawei-shell/storage";
import type { HuaweiInstalledApp } from "@/lib/huawei-shell/types";
import {
  CARD,
  BTN,
  BTN_GHOST,
  BTN_RED,
  INPUT,
  GUIDE_BOX,
  INK,
  SUB,
  FAINT,
  Badge,
  EmptyState,
  loadJson,
  saveJson,
  type BridgeTabProps,
} from "./shared";

/**
 * 应用管理 Tab（照搬 Operit 应用管理）：
 * 首次进入拉 getInstalledApps 列表并缓存到 kv，提供刷新；顶部搜索框按 label/pkg 过滤；
 * 每个应用卡片：打开(openApp) / 强停(am force-stop) / 卸载(二次确认后 pm uninstall)；
 * 底部按 APK 绝对路径 pm install -r 安装。全部经 Shizuku 实时执行，不写死。
 */

const APPS_KEY = "huawei_installed_apps_v1";

type AppsCache = { apps: HuaweiInstalledApp[]; updatedAt: number };

function loadCache(): AppsCache {
  const c = loadJson<AppsCache>(APPS_KEY, { apps: [], updatedAt: 0 });
  if (!c || !Array.isArray(c.apps)) return { apps: [], updatedAt: 0 };
  return c;
}

export function TabApps({ onNotice }: BridgeTabProps) {
  const [cache, setCache] = useState<AppsCache>(() => loadCache());
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [apkPath, setApkPath] = useState("");
  const [shellConnected, setShellConnected] = useState(false);

  const refresh = useCallback(() => {
    const shell = getAndroidShell();
    setShellConnected(shell !== null);
    if (!shell?.getInstalledApps) {
      onNotice?.("安卓壳未连接或不支持列出应用");
      return;
    }
    setRefreshing(true);
    try {
      const raw = shell.getInstalledApps();
      const parsed = JSON.parse(raw) as { ok: boolean; apps?: HuaweiInstalledApp[]; error?: string };
      if (parsed.ok && Array.isArray(parsed.apps)) {
        const next = { apps: parsed.apps, updatedAt: Date.now() };
        setCache(next);
        saveJson(APPS_KEY, next);
        onNotice?.(`已加载 ${parsed.apps.length} 个应用`);
      } else {
        onNotice?.(`加载失败：${parsed.error ?? "未知错误"}`);
      }
    } catch (e) {
      onNotice?.(`加载失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRefreshing(false);
    }
  }, [onNotice]);

  useEffect(() => {
    setShellConnected(getAndroidShell() !== null);
    if (cache.apps.length === 0) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runShell = (command: string): { ok: boolean; stdout?: string; stderr?: string; error?: string } => {
    const shell = getAndroidShell();
    if (!shell?.executeShellCommand) return { ok: false, error: "安卓壳未连接" };
    try {
      return JSON.parse(shell.executeShellCommand(command)) as { ok: boolean; stdout?: string; stderr?: string; error?: string };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  const openApp = (app: HuaweiInstalledApp) => {
    const shell = getAndroidShell();
    if (!shell?.openApp) { onNotice?.("安卓壳未连接"); return; }
    setBusy(b => ({ ...b, [app.pkg]: "open" }));
    try {
      const r = JSON.parse(shell.openApp(app.pkg)) as { ok: boolean; error?: string };
      onNotice?.(r.ok ? `已打开 ${app.label}` : `打开失败：${r.error ?? "未知"}`);
    } catch (e) {
      onNotice?.(`打开失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(b => { const n = { ...b }; delete n[app.pkg]; return n; });
    }
  };

  const forceStop = (app: HuaweiInstalledApp) => {
    setBusy(b => ({ ...b, [app.pkg]: "stop" }));
    const r = runShell(`am force-stop ${app.pkg}`);
    onNotice?.(r.ok ? `已强停 ${app.label}` : `强停失败：${r.error ?? r.stderr ?? "未知"}`);
    setBusy(b => { const n = { ...b }; delete n[app.pkg]; return n; });
  };

  const uninstall = (app: HuaweiInstalledApp) => {
    if (!window.confirm(`确认卸载 ${app.label}（${app.pkg}）？此操作不可撤销。`)) return;
    setBusy(b => ({ ...b, [app.pkg]: "uninstall" }));
    const r = runShell(`pm uninstall ${app.pkg}`);
    if (r.ok) {
      onNotice?.(`已卸载 ${app.label}`);
      setCache(c => ({ ...c, apps: c.apps.filter(a => a.pkg !== app.pkg) }));
    } else {
      onNotice?.(`卸载失败：${r.error ?? r.stderr ?? "未知"}`);
    }
    setBusy(b => { const n = { ...b }; delete n[app.pkg]; return n; });
  };

  const installApk = () => {
    const path = apkPath.trim();
    if (!path) { onNotice?.("请填写 APK 绝对路径"); return; }
    const r = runShell(`pm install -r ${path}`);
    onNotice?.(r.ok ? "APK 安装命令已执行" : `安装失败：${r.error ?? r.stderr ?? "未知"}`);
    if (r.ok) { setApkPath(""); setTimeout(refresh, 1200); }
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? cache.apps.filter(a => a.label.toLowerCase().includes(q) || a.pkg.toLowerCase().includes(q))
    : cache.apps;

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 工具条：搜索 + 刷新 */}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input style={{ ...INPUT, flex: 1 }} placeholder="搜索应用名 / 包名" value={query}
          onChange={e => setQuery(e.target.value)} />
        <button type="button" style={BTN_GHOST} onClick={refresh} disabled={refreshing}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: FAINT, marginTop: 6 }}>
        共 {cache.apps.length} 个应用{cache.updatedAt ? ` · 更新于 ${new Date(cache.updatedAt).toLocaleTimeString()}` : ""}
      </div>

      {/* 应用列表 */}
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.length === 0 ? (
          <EmptyState
            title={cache.apps.length === 0 ? "还没有应用列表" : "没有匹配的应用"}
            desc={cache.apps.length === 0
              ? "点右上角「刷新」从手机拉取已安装应用列表。"
              : "换个关键词试试。"}
            actionLabel="刷新应用列表"
            onAction={refresh}
          />
        ) : null}

        {filtered.map(app => (
          <div key={app.pkg} style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 13.5, color: INK }}>{app.label}</b>
                  {app.isSystem ? <Badge tone="gray" text="系统应用" /> : null}
                  {!app.isEnabled ? <Badge tone="amber" text="已停用" /> : null}
                </div>
                <div style={{ fontSize: 11, color: FAINT, marginTop: 3, wordBreak: "break-all" }}>{app.pkg}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button type="button" style={BTN} onClick={() => openApp(app)} disabled={!!busy[app.pkg]}>
                {busy[app.pkg] === "open" ? "打开中…" : "打开"}
              </button>
              <button type="button" style={BTN_GHOST} onClick={() => forceStop(app)} disabled={!!busy[app.pkg]}>
                {busy[app.pkg] === "stop" ? "强停中…" : "强停"}
              </button>
              <button type="button" style={BTN_RED} onClick={() => uninstall(app)} disabled={!!busy[app.pkg]}>
                {busy[app.pkg] === "uninstall" ? "卸载中…" : "卸载"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 按路径安装 APK */}
      <div style={{ ...CARD, marginTop: 14 }}>
        <b style={{ fontSize: 13.5, color: INK }}>按路径安装 APK</b>
        <div style={{ fontSize: 11.5, color: FAINT, marginTop: 3 }}>
          填写 APK 在手机上的绝对路径（如 /sdcard/Download/app.apk），经 Shizuku 执行 pm install -r。
        </div>
        <input style={{ ...INPUT, marginTop: 8 }} placeholder="/sdcard/Download/app.apk"
          value={apkPath} onChange={e => setApkPath(e.target.value)} />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button type="button" style={BTN} onClick={installApk}>安装 APK</button>
        </div>
      </div>

      {!shellConnected ? (
        <div style={{ ...GUIDE_BOX, marginTop: 12, marginBottom: 0 }}>
          安卓壳未连接时展示的是上次缓存的列表；在真机中打开后点「刷新」拉取实时数据。
        </div>
      ) : null}
    </div>
  );
}
