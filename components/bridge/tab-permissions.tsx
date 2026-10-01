"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAndroidShell } from "@/lib/huawei-shell/storage";
import type { HuaweiPermissionStatus } from "@/lib/huawei-shell/types";
import {
  CARD,
  BTN,
  BTN_GHOST,
  GUIDE_BOX,
  INK,
  SUB,
  FAINT,
  Badge,
  runShellAction,
  type BridgeTabProps,
} from "./shared";

/**
 * 权限 Tab（照搬 Operit 权限配置页）：
 * 实时拉 getPermissionStatus() 渲染五级权限——标准 / 无障碍 / 通知监听 /
 * 调试器(Shizuku) / 管理员(MediaProjection·悬浮窗·写设置) / Root。
 * 未授权项一键跳系统设置页；Shizuku 未装/未运行时给安装与 adb 激活引导。
 * 所有状态来自 window.AndroidShell 实时调用，壳未连接时优雅降级。
 */

type RowDef = {
  key: string;
  title: string;
  desc: string;
  granted: boolean;
  /** 跳转的系统设置页 key；为空则不显示跳转按钮 */
  setting?: string;
};

function Section({ title, rows, extra }: {
  title: string;
  rows: RowDef[];
  extra?: React.ReactNode;
}) {
  return (
    <div style={{ ...CARD, marginTop: 12 }}>
      <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 4 }}>{title}</b>
      {rows.map(r => (
        <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(150,190,230,.15)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{r.title}</div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>{r.desc}</div>
          </div>
          <Badge tone={r.granted ? "ok" : "red"} text={r.granted ? "已授权" : "未授权"} />
          {!r.granted && r.setting ? (
            <button type="button" style={{ ...BTN_GHOST, padding: "6px 12px", fontSize: 11.5 }}
              onClick={() => {
                const res = runShellAction("打开权限页", s => s.openPermissionSettings?.(r.setting!));
                if (!res.ok) alert(res.detail);
              }}>
              去开启
            </button>
          ) : null}
        </div>
      ))}
      {extra}
    </div>
  );
}

export function TabPerms({ onNotice }: BridgeTabProps) {
  const [status, setStatus] = useState<HuaweiPermissionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [shellConnected, setShellConnected] = useState(false);

  const load = useCallback(() => {
    const shell = getAndroidShell();
    setShellConnected(shell !== null);
    if (!shell?.getPermissionStatus) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      const raw = shell.getPermissionStatus("");
      const parsed = JSON.parse(raw) as HuaweiPermissionStatus;
      setStatus(parsed);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 定位：首次读到未授权时自动弹系统授权框（每页生命周期只弹一次）
  const locationAsked = useRef(false);
  useEffect(() => {
    if (!status || locationAsked.current) return;
    if (status.standard.location) return;
    locationAsked.current = true;
    runShellAction("请求定位权限", s => s.requestLocationPermission?.());
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [status, load]);

  // 状态每 5 秒随壳自动刷新一次（与顶部概览卡同步）
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const requestShizuku = () => {
    const res = runShellAction("请求 Shizuku 授权", s => s.requestShizukuPermission?.());
    onNotice?.(res.detail);
    setTimeout(load, 800);
  };

  const installShizuku = () => {
    const res = runShellAction("安装内置 Shizuku", s => s.installBundledShizuku?.());
    onNotice?.(res.detail);
    setTimeout(load, 1500);
  };

  if (!shellConnected) {
    return (
      <div style={{ ...GUIDE_BOX, marginTop: 14, marginBottom: 0 }}>
        安卓壳未连接。在真机 WebView 中打开后，这里会实时列出五级权限状态。
      </div>
    );
  }

  const d = status?.debugger;
  const shizukuInstalled = d?.shizukuInstalled === true;
  const shizukuRunning = d?.shizukuRunning === true;
  const shizukuGranted = d?.shizukuPermission === true;

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 顶部刷新 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
        <span style={{ fontSize: 12, color: SUB }}>
          {loading ? "刷新中…" : "状态实时取自安卓壳，操作后请点刷新"}
        </span>
        <button type="button" style={BTN_GHOST} onClick={load}>刷新状态</button>
      </div>

      {!status ? (
        <div style={{ ...GUIDE_BOX, marginBottom: 0 }}>
          未取到权限数据。请确认安卓壳已就绪后点「刷新状态」。
        </div>
      ) : (
        <>
          {/* 1. 标准权限 */}
          <Section title="标准权限" rows={[
            { key: "location", title: "定位", desc: "粗 / 精确定位", granted: status.standard.location, setting: "location" },
            { key: "microphone", title: "麦克风", desc: "录音 / 语音识别", granted: status.standard.microphone, setting: "microphone" },
            { key: "storage", title: "存储", desc: "读写外部存储", granted: status.standard.storage, setting: "storage" },
          ]} />

          {/* 2. 无障碍 */}
          <Section title="无障碍服务" rows={[
            { key: "accessibility", title: "无障碍", desc: "读取屏幕节点 / 自动点击（屏幕速聊依赖）", granted: status.accessibility, setting: "accessibility" },
            { key: "notif", title: "通知监听", desc: "读取通知（自动记账 / 联动规则依赖）", granted: status.notificationListener, setting: "notification" },
          ]} />

          {/* 3. 调试器 Shizuku */}
          <Section title="调试器 · Shizuku" rows={[
            { key: "shell", title: "Shell 执行", desc: "经 Shizuku 执行系统命令", granted: d?.shell === true && shizukuGranted },
            { key: "file", title: "文件访问", desc: "读写外部存储", granted: d?.file === true },
          ]} extra={
            <div style={{ ...GUIDE_BOX, marginTop: 10, marginBottom: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <b style={{ color: INK }}>Shizuku</b>
                <Badge tone={shizukuInstalled ? "ok" : "gray"} text={shizukuInstalled ? "已安装" : "未安装"} />
                <Badge tone={shizukuRunning ? "ok" : "amber"} text={shizukuRunning ? "运行中" : "未运行"} />
                <Badge tone={shizukuGranted ? "ok" : "red"} text={shizukuGranted ? "已授权" : "未授权"} />
              </div>
              {!shizukuInstalled ? (
                <div style={{ marginTop: 8, color: SUB }}>
                  <div style={{ marginBottom: 8 }}>
                    点下方「安装 Shizuku」由壳内置 APK 一键安装；装好后再用 adb（或无线调试）激活服务。
                  </div>
                  <button type="button" style={BTN} onClick={installShizuku}>安装 Shizuku</button>
                </div>
              ) : !shizukuRunning ? (
                <div style={{ marginTop: 8, color: SUB }}>
                  Shizuku 已安装但服务未运行。请用电脑 adb 执行 Shizuku 应用内给出的启动命令后回来刷新。
                </div>
              ) : !shizukuGranted ? (
                <div style={{ marginTop: 10 }}>
                  <button type="button" style={BTN} onClick={requestShizuku}>授权 Shizuku</button>
                </div>
              ) : (
                <div style={{ marginTop: 8, color: "rgba(47,164,106,.9)" }}>Shizuku 全部就绪，可执行系统级操作。</div>
              )}
            </div>
          } />

          {/* 4. 管理员 */}
          <Section title="管理员权限" rows={[
            { key: "overlay", title: "悬浮窗", desc: "悬浮球 / 速聊浮窗", granted: status.admin.overlay, setting: "overlay" },
            { key: "write", title: "写系统设置", desc: "改亮度 / 音量 / 飞行模式", granted: status.admin.writeSettings, setting: "write_settings" },
            { key: "battery", title: "电池优化白名单", desc: "前台推送 / 悬浮球不被系统杀死", granted: status.admin.batteryOptimization, setting: "battery" },
            { key: "media", title: "截屏录屏", desc: "MediaProjection 截屏（用时临时授权）", granted: status.admin.mediaProjection },
          ]} />

          {/* 5. Root */}
          <div style={{ ...CARD, marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 13.5, color: INK }}>Root</b>
                <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>{status.root.hint}</div>
              </div>
              <Badge tone={status.root.granted ? "ok" : "gray"} text={status.root.granted ? "已获取" : "不可用"} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
