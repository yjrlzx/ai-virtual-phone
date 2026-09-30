"use client";

import { useCallback, useEffect, useState } from "react";
import { getAndroidShell } from "@/lib/huawei-shell/storage";
import {
  CARD,
  BTN,
  BTN_GHOST,
  INPUT,
  GUIDE_BOX,
  INK,
  SUB,
  FAINT,
  Switch,
  Badge,
  type BridgeTabProps,
} from "./shared";

/**
 * 系统设置 Tab（照搬 Operit 系统设置修改）：
 * 亮度滑杆、媒体/铃声音量滑杆（直连 setBrightness/setVolume），
 * 飞行模式 / WiFi 开关经 executeShellCommand 操作后重新读 settings 刷新状态；
 * 蓝牙、媒体键、系统设置读写、文件管理走新增桥方法，全部实时读取，不写死。
 */

type ShellJson = { ok: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string };

function runShell(command: string): ShellJson {
  const shell = getAndroidShell();
  if (!shell?.executeShellCommand) return { ok: false, error: "安卓壳未连接" };
  try {
    const raw = shell.executeShellCommand(command);
    return JSON.parse(raw) as ShellJson;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 读 settings global 开关，stdout 为 "1"/"0" */
function readOnOff(key: string): boolean | null {
  const r = runShell(`settings get global ${key}`);
  if (!r.ok) return null;
  const v = (r.stdout ?? "").trim();
  if (v === "1") return true;
  if (v === "0") return false;
  return null;
}

/** 调一个桥方法并解析返回 JSON，失败返回 {ok:false,error} */
function callShell<T = Record<string, unknown>>(
  fn: (shell: NonNullable<ReturnType<typeof getAndroidShell>>) => string | undefined | null,
): T & { ok: boolean; error?: string } {
  const shell = getAndroidShell();
  if (!shell) return { ok: false, error: "安卓壳未连接" } as T & { ok: boolean; error?: string };
  try {
    const raw = fn(shell);
    if (!raw) return { ok: false, error: "壳未返回数据" } as T & { ok: boolean; error?: string };
    return JSON.parse(raw) as T & { ok: boolean; error?: string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) } as T & { ok: boolean; error?: string };
  }
}

type BondedDevice = { name?: string; address?: string };
type FileMatch = { path: string; size: number; isDir: boolean };

export function TabSystem({ onNotice }: BridgeTabProps) {
  const [brightness, setBrightness] = useState(60);
  const [mediaVol, setMediaVol] = useState(50);
  const [ringVol, setRingVol] = useState(50);
  const [airplane, setAirplane] = useState<boolean | null>(null);
  const [wifi, setWifi] = useState<boolean | null>(null);
  const [shellConnected, setShellConnected] = useState(false);

  // 蓝牙
  const [btEnabled, setBtEnabled] = useState<boolean | null>(null);
  const [btAvailable, setBtAvailable] = useState<boolean | null>(null);
  const [bonded, setBonded] = useState<BondedDevice[]>([]);

  // 系统设置读写
  const [ns, setNs] = useState<"system" | "secure" | "global">("global");
  const [settingKey, setSettingKey] = useState("");
  const [settingValue, setSettingValue] = useState("");
  const [settingResult, setSettingResult] = useState("");

  // 文件管理
  const [fmPath, setFmPath] = useState("");
  const [fmContent, setFmContent] = useState("");
  const [fmQuery, setFmQuery] = useState("");
  const [fmMatches, setFmMatches] = useState<FileMatch[]>([]);
  const [fmResult, setFmResult] = useState("");

  const readSwitches = useCallback(() => {
    setShellConnected(getAndroidShell() !== null);
    setAirplane(readOnOff("airplane_mode_on"));
    setWifi(readOnOff("wifi_on"));
  }, []);

  const readBluetooth = useCallback(() => {
    const st = callShell<{ enabled: boolean; available: boolean }>(s => s.getBluetoothState?.());
    setBtEnabled(st.ok ? st.enabled : null);
    setBtAvailable(st.ok ? st.available : null);
    if (!st.ok) return;
    const bd = callShell<{ devices: BondedDevice[] }>(s => s.listBondedDevices?.());
    setBonded(bd.ok ? (bd.devices ?? []) : []);
  }, []);

  useEffect(() => {
    readSwitches();
    readBluetooth();
  }, [readSwitches, readBluetooth]);

  const applyBrightness = (v: number) => {
    setBrightness(v);
    const shell = getAndroidShell();
    if (!shell?.setBrightness) return;
    try { shell.setBrightness(v); } catch { /* 忽略，下次滑动重试 */ }
  };

  const applyVolume = (stream: "media" | "ring", v: number) => {
    if (stream === "media") setMediaVol(v); else setRingVol(v);
    const shell = getAndroidShell();
    if (!shell?.setVolume) return;
    try { shell.setVolume(stream, v); } catch { /* 忽略 */ }
  };

  const toggleAirplane = () => {
    const next = !(airplane === true);
    setAirplane(next);
    const cmd = next
      ? "settings put global airplane_mode_on 1; am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true"
      : "settings put global airplane_mode_on 0; am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false";
    const r = runShell(cmd);
    onNotice?.(r.ok ? (next ? "飞行模式已开启" : "飞行模式已关闭") : `失败：${r.error ?? r.stderr ?? "未知"}`);
    setTimeout(readSwitches, 600);
  };

  const toggleWifi = () => {
    const next = !(wifi === true);
    setWifi(next);
    const cmd = next ? "svc wifi enable" : "svc wifi disable";
    const r = runShell(cmd);
    onNotice?.(r.ok ? (next ? "WiFi 已开启" : "WiFi 已关闭") : `失败：${r.error ?? r.stderr ?? "未知"}`);
    setTimeout(readSwitches, 800);
  };

  const toggleBluetooth = () => {
    const next = !(btEnabled === true);
    setBtEnabled(next);
    const r = callShell<{ enabled: boolean }>(s => s.setBluetoothEnabled?.(next));
    if (r.ok) {
      setBtEnabled(r.enabled);
      onNotice?.(next ? "蓝牙已开启" : "蓝牙已关闭");
    } else {
      onNotice?.(`蓝牙操作失败：${r.error ?? "未知"}`);
    }
    setTimeout(readBluetooth, 800);
  };

  const doMusic = (action: "previous" | "play_pause" | "next" | "stop", label: string) => {
    const r = callShell<{ action: string; viaShizuku: boolean }>(s => s.musicControl?.(action));
    onNotice?.(r.ok ? `${label} 已发送${r.viaShizuku ? "（Shizuku）" : ""}` : `${label} 失败：${r.error ?? "未知"}`);
  };

  const doReadSetting = () => {
    if (!settingKey.trim()) { onNotice?.("请输入设置键"); return; }
    const r = callShell<{ value: string }>(s => s.getSystemSetting?.(ns, settingKey.trim()));
    setSettingResult(r.ok ? `读取成功（${ns}/${settingKey}）：${r.value ?? "(空)"}` : `读取失败：${r.error ?? "未知"}`);
  };

  const doWriteSetting = () => {
    if (!settingKey.trim()) { onNotice?.("请输入设置键"); return; }
    const r = callShell(s => s.setSystemSetting?.(ns, settingKey.trim(), settingValue));
    setSettingResult(r.ok ? `写入成功（${ns}/${settingKey} = ${settingValue}）` : `写入失败：${r.error ?? "未知"}`);
  };

  const doWriteFile = () => {
    if (!fmPath.trim()) { onNotice?.("请输入文件路径"); return; }
    const r = callShell<{ bytes: number; path: string }>(s => s.writeFile?.(fmPath.trim(), fmContent));
    setFmResult(r.ok ? `已写入 ${r.path}（${r.bytes} 字节）` : `写入失败：${r.error ?? "未知"}`);
  };

  const doDeleteFile = () => {
    if (!fmPath.trim()) { onNotice?.("请输入要删除的路径"); return; }
    const r = callShell(s => s.deleteFile?.(fmPath.trim()));
    setFmResult(r.ok ? `已删除 ${fmPath.trim()}` : `删除失败：${r.error ?? "未知"}`);
  };

  const doMkdir = () => {
    if (!fmPath.trim()) { onNotice?.("请输入目录路径"); return; }
    const r = callShell(s => s.makeDirectory?.(fmPath.trim()));
    setFmResult(r.ok ? `已建目录 ${fmPath.trim()}` : `建目录失败：${r.error ?? "未知"}`);
  };

  const doFind = () => {
    if (!fmPath.trim()) { onNotice?.("请输入查找根目录"); return; }
    const r = callShell<{ matches: FileMatch[]; count: number }>(s => s.findFiles?.(fmPath.trim(), fmQuery.trim()));
    if (r.ok) {
      setFmMatches(r.matches ?? []);
      setFmResult(`找到 ${r.count ?? 0} 项`);
    } else {
      setFmMatches([]);
      setFmResult(`查找失败：${r.error ?? "未知"}`);
    }
  };

  const sliderStyle: React.CSSProperties = { width: "100%", accentColor: "#6ab0f3" };

  return (
    <div style={{ paddingTop: 6 }}>
      {!shellConnected ? (
        <div style={{ ...GUIDE_BOX, marginTop: 14, marginBottom: 0 }}>
          安卓壳未连接。在真机 WebView 中打开后，这里可实时调亮度 / 音量 / 飞行模式 / WiFi / 蓝牙 / 媒体键 / 文件管理。
        </div>
      ) : null}

      {/* 亮度 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <b style={{ fontSize: 13.5, color: INK }}>屏幕亮度</b>
          <span style={{ fontSize: 12, color: SUB, fontVariantNumeric: "tabular-nums" }}>{brightness}%</span>
        </div>
        <input type="range" min={0} max={100} value={brightness} style={sliderStyle}
          onChange={e => applyBrightness(Number(e.target.value))} />
      </div>

      {/* 音量 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <b style={{ fontSize: 13.5, color: INK }}>媒体音量</b>
          <span style={{ fontSize: 12, color: SUB, fontVariantNumeric: "tabular-nums" }}>{mediaVol}%</span>
        </div>
        <input type="range" min={0} max={100} value={mediaVol} style={sliderStyle}
          onChange={e => applyVolume("media", Number(e.target.value))} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <b style={{ fontSize: 13.5, color: INK }}>铃声音量</b>
          <span style={{ fontSize: 12, color: SUB, fontVariantNumeric: "tabular-nums" }}>{ringVol}%</span>
        </div>
        <input type="range" min={0} max={100} value={ringVol} style={sliderStyle}
          onChange={e => applyVolume("ring", Number(e.target.value))} />
      </div>

      {/* 飞行模式 / WiFi */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 2 }}>网络开关</b>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid rgba(150,190,230,.15)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>飞行模式</div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>
              {airplane === null ? "状态未知" : airplane ? "已开启" : "已关闭"}
            </div>
          </div>
          <Switch on={airplane === true} onChange={toggleAirplane} label="飞行模式" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>WiFi</div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>
              {wifi === null ? "状态未知" : wifi ? "已开启" : "已关闭"}
            </div>
          </div>
          <Switch on={wifi === true} onChange={toggleWifi} label="WiFi" />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" style={BTN_GHOST} onClick={readSwitches}>刷新网络状态</button>
      </div>

      {/* 蓝牙 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid rgba(150,190,230,.15)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>蓝牙</div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>
              {btAvailable === false
                ? "本机无蓝牙模块"
                : btEnabled === null ? "状态未知" : btEnabled ? "已开启" : "已关闭"}
            </div>
          </div>
          <Switch on={btEnabled === true} onChange={toggleBluetooth} label="蓝牙" />
        </div>
        <div style={{ padding: "11px 0 4px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>已配对设备</span>
            <button type="button" style={BTN_GHOST} onClick={readBluetooth} disabled={!shellConnected}>刷新</button>
          </div>
          {bonded.length === 0 ? (
            <div style={{ fontSize: 11.5, color: FAINT }}>暂无已配对设备（或未授予蓝牙权限）</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {bonded.map(d => (
                <li key={d.address ?? d.name} style={{ fontSize: 12.5, color: SUB, lineHeight: 1.8 }}>
                  <b style={{ color: INK }}>{d.name || "(未命名)"}</b>
                  <span style={{ color: FAINT, marginLeft: 8, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11 }}>{d.address}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 媒体控制 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 8 }}>媒体控制</b>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={BTN_GHOST} onClick={() => doMusic("previous", "上一首")} disabled={!shellConnected}>⏮ 上一首</button>
          <button type="button" style={BTN} onClick={() => doMusic("play_pause", "播放/暂停")} disabled={!shellConnected}>⏯ 播放/暂停</button>
          <button type="button" style={BTN_GHOST} onClick={() => doMusic("next", "下一首")} disabled={!shellConnected}>⏭ 下一首</button>
          <button type="button" style={BTN_GHOST} onClick={() => doMusic("stop", "停止")} disabled={!shellConnected}>⏹ 停止</button>
        </div>
        <p style={{ fontSize: 11, color: FAINT, margin: "8px 0 0", lineHeight: 1.6 }}>
          经 input keyevent 发送媒体键（优先 Shizuku），控制前台音乐 App。
        </p>
      </div>

      {/* 系统设置读写 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 8 }}>系统设置读写</b>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={ns}
            onChange={e => setNs(e.target.value as "system" | "secure" | "global")}
            style={{ ...INPUT, width: 110 }}
          >
            <option value="system">system</option>
            <option value="secure">secure</option>
            <option value="global">global</option>
          </select>
          <input style={{ ...INPUT, flex: 1, minWidth: 140 }} placeholder="键名，如 screen_brightness"
            value={settingKey} onChange={e => setSettingKey(e.target.value)} />
          <input style={{ ...INPUT, flex: 1, minWidth: 140 }} placeholder="写入值（读取时可留空）"
            value={settingValue} onChange={e => setSettingValue(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button type="button" style={BTN_GHOST} onClick={doReadSetting} disabled={!shellConnected}>读取</button>
          <button type="button" style={BTN} onClick={doWriteSetting} disabled={!shellConnected}>写入</button>
        </div>
        {settingResult ? (
          <pre style={{
            marginTop: 10, marginBottom: 0, maxHeight: 120, overflow: "auto",
            background: "rgba(150,190,230,.08)", borderRadius: 10,
            padding: 10, fontSize: 11.5, lineHeight: 1.5, color: SUB,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>{settingResult}</pre>
        ) : null}
      </div>

      {/* 文件管理 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 8 }}>文件管理</b>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input style={{ ...INPUT, flex: 1, minWidth: 200 }} placeholder="路径，如 /sdcard/Download/test.txt"
            value={fmPath} onChange={e => setFmPath(e.target.value)} />
          <input style={{ ...INPUT, flex: 1, minWidth: 160 }} placeholder="查找关键字（按文件名包含匹配）"
            value={fmQuery} onChange={e => setFmQuery(e.target.value)} />
        </div>
        <textarea
          style={{ ...INPUT, marginTop: 8, minHeight: 70, resize: "vertical", fontFamily: "inherit" }}
          placeholder="写文件时写入的文本内容"
          value={fmContent} onChange={e => setFmContent(e.target.value)} />
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button type="button" style={BTN} onClick={doWriteFile} disabled={!shellConnected}>写文件</button>
          <button type="button" style={BTN_GHOST} onClick={doDeleteFile} disabled={!shellConnected}>删文件</button>
          <button type="button" style={BTN_GHOST} onClick={doMkdir} disabled={!shellConnected}>建目录</button>
          <button type="button" style={BTN_GHOST} onClick={doFind} disabled={!shellConnected}>查找</button>
        </div>
        {fmResult ? (
          <pre style={{
            marginTop: 10, marginBottom: 0, maxHeight: 100, overflow: "auto",
            background: "rgba(150,190,230,.08)", borderRadius: 10,
            padding: 10, fontSize: 11.5, lineHeight: 1.5, color: SUB,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>{fmResult}</pre>
        ) : null}
        {fmMatches.length > 0 ? (
          <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18 }}>
            {fmMatches.map(m => (
              <li key={m.path} style={{ fontSize: 12, color: SUB, lineHeight: 1.8, wordBreak: "break-all" }}>
                <Badge tone={m.isDir ? "amber" : "gray"} text={m.isDir ? "目录" : "文件"} />
                <span style={{ marginLeft: 8, color: INK }}>{m.path}</span>
                <span style={{ marginLeft: 8, color: FAINT, fontSize: 11 }}>{m.size} B</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <p style={{ fontSize: 11, color: FAINT, lineHeight: 1.6, marginTop: 10 }}>
        飞行模式 / WiFi 经 Shizuku 执行系统命令，操作后约 1 秒自动回读最新状态；亮度与音量实时下发。
        蓝牙 / 媒体键 / 设置读写 / 文件管理均为壳侧实时桥方法，未连接时按钮禁用。
      </p>
    </div>
  );
}
