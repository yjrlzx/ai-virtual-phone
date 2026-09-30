"use client";

import { useEffect, useRef, useState } from "react";
import { getAndroidShell, loadHuaweiShellSettings, parseShellJson, readVoiceAssistantConfig, saveVoiceAssistantConfig, VOICE_ASSISTANT_DEFAULT_VOICES, type VoiceAssistantConfig } from "@/lib/huawei-shell/storage";
import type { HuaweiShellBridge, HuaweiWakeWordMode } from "@/lib/huawei-shell/types";
import { resolveVoiceConfig } from "@/lib/tts-service";
import {
  ACCENT,
  BTN,
  BTN_GHOST,
  CARD,
  FAINT,
  GUIDE_BOX,
  INK,
  INPUT,
  SUB,
  Badge,
  Switch,
  loadJson,
  runShellAction,
  saveJson,
  type BridgeTabProps,
} from "./shared";

/**
 * 语音 Tab：语音唤醒配置 + 连续语音对话闭环 + 自动朗读开关 + 真机保活引导。
 * 状态全部来自 window.AndroidShell（每 3 秒轮询 ttsStatus / 模板数）或 kv 缓存
 * （huawei_voice_config_v1）；壳未连接时优雅降级，不写死演示数据。
 *
 * 连续对话闭环：
 *   唤醒词命中 → speak 一句确认语 → startListening 收用户语音
 *   → __floatBridgeOnSpeechText 回传文本（本地 transcript 追加 + 派发 float:voice-text 给聊天层）
 *   → 聊天层回 float:assistant-text → autoSpeak 朗读
 *   → __floatBridgeOnTtsEvent utteranceDone → 再次 startListening。
 */

const VOICE_CFG_KEY = "huawei_voice_config_v1";

type VoiceConfig = {
  wakeWord: string;
  mode: HuaweiWakeWordMode;
  continuousDialogue: boolean;
  autoSpeak: boolean;
  rate: number;
  pitch: number;
  /** 唤醒命中后的确认语（连续对话开启时播报） */
  wakeConfirmText: string;
  /** 试读按钮朗读的测试文本 */
  testText: string;
};

const DEFAULT_VOICE_CFG: VoiceConfig = {
  wakeWord: "",
  mode: "system",
  continuousDialogue: false,
  autoSpeak: false,
  rate: 1.0,
  pitch: 1.0,
  wakeConfirmText: "我在，请说",
  testText: "你好，这是语音朗读测试",
};

type TranscriptItem = { ts: number; text: string };

/** 下发一次 TTS；未提供能力时静默返回 false */
function doSpeak(shell: HuaweiShellBridge, cfg: VoiceConfig, text: string, queue: boolean): boolean {
  if (typeof shell.speak !== "function") return false;
  const payload: Record<string, unknown> = { text, queue, rate: cfg.rate, pitch: cfg.pitch };
  // 解析当前角色绑定的 MiniMax 音色：有 apiKey 就把在线合成参数带给壳，
  // 让壳走 MiniMax 在线 TTS 而不是系统 TTS；没配则回退系统 TTS。
  try {
    const vc = resolveVoiceConfig("voice-assistant");
    if (vc && vc.provider === "Minimax" && vc.apiKey) {
      payload.apiKey = vc.apiKey;
      payload.voiceId = vc.defaultVoice;
      if (vc.baseUrl) payload.baseUrl = vc.baseUrl;
      if (vc.model) payload.model = vc.model;
    }
  } catch { /* 音色解析失败回退系统 TTS */ }
  shell.speak(JSON.stringify(payload));
  return true;
}

/** 下发唤醒词配置并常驻监听 */
function doStartWake(shell: HuaweiShellBridge, cfg: VoiceConfig): boolean {
  if (typeof shell.startWakeWord !== "function") return false;
  shell.startWakeWord(JSON.stringify({ wakeWord: cfg.wakeWord, mode: cfg.mode }));
  return true;
}

/** 开始一次语音转写（在线模式参数复用全局 STT 设置） */
function doStartListen(shell: HuaweiShellBridge): void {
  if (typeof shell.startListening !== "function") return;
  const s = loadHuaweiShellSettings();
  const mode = s.sttMode === "cloud" ? "system" : s.sttMode;
  shell.startListening(JSON.stringify({
    mode,
    url: s.sttOnlineUrl,
    key: s.sttOnlineKey,
    model: s.sttOnlineModel,
  }));
}

export function TabVoice({ onNotice }: BridgeTabProps) {
  const [cfg, setCfg] = useState<VoiceConfig>(() => ({ ...DEFAULT_VOICE_CFG, ...loadJson<Partial<VoiceConfig>>(VOICE_CFG_KEY, {}) }));
  const [shellConnected, setShellConnected] = useState(false);
  const [wakeOn, setWakeOn] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [templateCount, setTemplateCount] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  // 语音助手 MiniMax 配置：与现实桥设置页同一份 store（resolveVoiceConfig("voice-assistant")）
  const [voiceCfg, setVoiceCfg] = useState<VoiceAssistantConfig>(() => readVoiceAssistantConfig());

  const updateVoiceCfg = (patch: Partial<VoiceAssistantConfig>) => {
    setVoiceCfg(prev => {
      const next = { ...prev, ...patch };
      saveVoiceAssistantConfig(next);
      return next;
    });
  };

  // 用 ref 让全局回调始终读到最新配置，避免反复拆装 window 监听
  const cfgRef = useRef(cfg);
  useEffect(() => { cfgRef.current = cfg; }, [cfg]);
  const contOnRef = useRef(cfg.continuousDialogue);
  useEffect(() => { contOnRef.current = cfg.continuousDialogue; }, [cfg.continuousDialogue]);

  const updateCfg = (patch: Partial<VoiceConfig>) => {
    setCfg(prev => {
      const next = { ...prev, ...patch };
      saveJson(VOICE_CFG_KEY, next);
      return next;
    });
  };

  /* ---- 每 3 秒轮询壳连接 / 朗读状态 / 模板数 ---- */
  useEffect(() => {
    const tick = () => {
      const shell = getAndroidShell();
      setShellConnected(shell !== null);
      if (!shell) return;
      const st = parseShellJson<{ speaking?: boolean }>(shell.ttsStatus?.());
      if (st) setSpeaking(st.speaking === true);
      const tpl = parseShellJson<{ count?: number }>(shell.listWakeTemplates?.());
      if (tpl && typeof tpl.count === "number") setTemplateCount(tpl.count);
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  /* ---- 连续对话：命中唤醒词 → 确认语 → 收声 → 抛文本 → 等 TTS 播完再开麦 ---- */
  useEffect(() => {
    if (!cfg.continuousDialogue) return;
    const shell = getAndroidShell();
    if (!shell) return;
    const w = window as unknown as {
      __floatBridgeOnSpeechText?: (json: string) => void;
      __floatBridgeOnWakeWord?: (json: string) => void;
      __floatBridgeOnTtsEvent?: (json: string) => void;
    };

    const beginListening = () => {
      if (!contOnRef.current) return;
      const sh = getAndroidShell();
      if (sh) doStartListen(sh);
    };

    // 开启连续对话即拉起常驻唤醒服务
    if (doStartWake(shell, cfgRef.current)) setWakeOn(true);

    const prevSpeech = w.__floatBridgeOnSpeechText;
    const speechHandler = (json: string) => {
      try {
        const parsed = JSON.parse(json) as { ok?: boolean; text?: string; error?: string };
        if (parsed.ok && typeof parsed.text === "string" && parsed.text.trim()) {
          const text = parsed.text.trim();
          setTranscript(list => [...list.slice(-30), { ts: Date.now(), text }]);
          window.dispatchEvent(new CustomEvent("float:voice-text", { detail: { text } }));
        } else if (parsed.ok === false) {
          onNotice?.(`识别失败：${parsed.error ?? "未知"}`);
        }
      } catch { /* 非法回传忽略 */ }
      if (typeof prevSpeech === "function") { try { prevSpeech(json); } catch { /* 忽略 */ } }
    };
    w.__floatBridgeOnSpeechText = speechHandler;

    const prevWake = w.__floatBridgeOnWakeWord;
    const wakeHandler = (json: string) => {
      try {
        const parsed = JSON.parse(json) as { ok?: boolean; matched?: boolean; text?: string };
        if (parsed.ok && contOnRef.current) {
          const sh = getAndroidShell();
          if (sh) {
            doSpeak(sh, cfgRef.current, cfgRef.current.wakeConfirmText, false);
            // TTS 不可用或事件未回传时的兜底延时开麦
            setTimeout(beginListening, 700);
          }
        }
      } catch { /* 非法回传忽略 */ }
      if (typeof prevWake === "function") { try { prevWake(json); } catch { /* 忽略 */ } }
    };
    w.__floatBridgeOnWakeWord = wakeHandler;

    const prevTts = w.__floatBridgeOnTtsEvent;
    const ttsHandler = (json: string) => {
      try {
        const parsed = JSON.parse(json) as { type?: string; text?: string; error?: string };
        if (parsed.type === "utteranceDone" && contOnRef.current) {
          beginListening();
        }
        if (parsed.type === "error") {
          onNotice?.(`朗读出错：${parsed.error ?? "未知"}`);
        }
      } catch { /* 非法回传忽略 */ }
      if (typeof prevTts === "function") { try { prevTts(json); } catch { /* 忽略 */ } }
    };
    w.__floatBridgeOnTtsEvent = ttsHandler;

    return () => {
      const sh = getAndroidShell();
      try { sh?.stopListening?.(); } catch { /* 忽略 */ }
      try { sh?.stopWakeWord?.(); } catch { /* 忽略 */ }
      setWakeOn(false);
      // 仅还原本组件装上的包装函数，避免误删通话页 / 调度器的监听
      if (w.__floatBridgeOnSpeechText === speechHandler) {
        w.__floatBridgeOnSpeechText = (typeof prevSpeech === "function" ? prevSpeech : undefined);
      }
      if (w.__floatBridgeOnWakeWord === wakeHandler) {
        w.__floatBridgeOnWakeWord = (typeof prevWake === "function" ? prevWake : undefined);
      }
      if (w.__floatBridgeOnTtsEvent === ttsHandler) {
        w.__floatBridgeOnTtsEvent = (typeof prevTts === "function" ? prevTts : undefined);
      }
    };
  }, [cfg.continuousDialogue, onNotice]);

  /* ---- 自动朗读：聊天层抛 float:assistant-text，开着就 speak（没事件不报错） ---- */
  useEffect(() => {
    const handler = (e: Event) => {
      if (!cfgRef.current.autoSpeak) return;
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      const text = detail?.text;
      if (!text) return;
      const shell = getAndroidShell();
      if (!shell) return;
      doSpeak(shell, cfgRef.current, text, true);
    };
    window.addEventListener("float:assistant-text", handler);
    return () => window.removeEventListener("float:assistant-text", handler);
  }, []);

  /* ---- 语音唤醒主开关 ---- */
  const toggleWake = () => {
    const shell = getAndroidShell();
    if (!shell) { onNotice?.("安卓壳未连接"); return; }
    if (wakeOn) {
      try { shell.stopWakeWord?.(); } catch { /* 忽略 */ }
      setWakeOn(false);
      onNotice?.("已关闭语音唤醒");
    } else {
      if (!cfg.wakeWord.trim()) { onNotice?.("请先填写唤醒词"); return; }
      if (doStartWake(shell, cfg)) {
        setWakeOn(true);
        onNotice?.("已开启语音唤醒");
      }
    }
  };

  /* ---- 录制 / 清空唤醒词模板 ---- */
  const doEnroll = () => {
    const shell = getAndroidShell();
    if (!shell) { onNotice?.("安卓壳未连接"); return; }
    try {
      const parsed = parseShellJson<{ ok?: boolean; templates?: number; error?: string }>(shell.enrollWakeWord?.());
      if (parsed?.ok && typeof parsed.templates === "number") {
        setTemplateCount(parsed.templates);
        onNotice?.(`已录 ${parsed.templates}/3 条模板`);
      } else {
        onNotice?.(parsed?.error ?? "录制失败");
      }
    } catch (e) {
      onNotice?.(e instanceof Error ? e.message : String(e));
    }
  };

  const doClearTemplates = () => {
    const shell = getAndroidShell();
    if (!shell) { onNotice?.("安卓壳未连接"); return; }
    try { shell.clearWakeTemplates?.(); } catch { /* 忽略 */ }
    setTemplateCount(0);
    onNotice?.("已清空唤醒词模板");
  };

  /* ---- 试读 ---- */
  const trySpeak = () => {
    const shell = getAndroidShell();
    if (!shell) { onNotice?.("安卓壳未连接"); return; }
    if (!doSpeak(shell, cfg, cfg.testText, false)) { onNotice?.("壳未提供朗读能力"); return; }
  };

  const sliderStyle: React.CSSProperties = { width: "100%", accentColor: "#6ab0f3" };

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 顶部状态行 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        <Badge tone={shellConnected ? "ok" : "amber"} text={shellConnected ? "壳已连接" : "壳未连接"} />
        <Badge tone={wakeOn ? "ok" : "gray"} text={wakeOn ? "唤醒服务 开" : "唤醒服务 关"} />
        <Badge tone="gray" text={`模板数 ${templateCount}`} />
        <Badge tone={speaking ? "ok" : "gray"} text={speaking ? "朗读中" : "空闲"} />
      </div>

      {!shellConnected ? (
        <div style={{ ...GUIDE_BOX, marginTop: 12, marginBottom: 0 }}>
          安卓壳未连接。在真机 WebView 中打开后，这里可配置唤醒词、连续对话与自动朗读。
        </div>
      ) : null}

      {/* a. 语音唤醒 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 4 }}>语音唤醒</b>
        <span style={{ fontSize: 11, color: FAINT }}>唤醒词常驻监听，命中后经 __floatBridgeOnWakeWord 回传网页。</span>

        <div style={{ marginTop: 10 }}>
          <i style={{ fontStyle: "normal", fontSize: 11.5, color: SUB, display: "block", marginBottom: 4 }}>唤醒词</i>
          <input
            type="text"
            value={cfg.wakeWord}
            placeholder="例如 你好小浮"
            onChange={e => updateCfg({ wakeWord: e.target.value })}
            style={INPUT}
          />
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
          {([["system", "系统识别"], ["on_device", "端上模板"]] as Array<[HuaweiWakeWordMode, string]>).map(([m, label]) => {
            const on = cfg.mode === m;
            return (
              <button key={m} type="button" onClick={() => updateCfg({ mode: m })}
                style={{
                  border: "none", borderRadius: 999, padding: "6px 13px", fontSize: 11.5, fontWeight: 700,
                  cursor: "pointer", background: on ? ACCENT : "rgba(150,190,230,.15)", color: on ? "#fff" : SUB,
                }}>
                {label}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0 4px", borderTop: "1px solid rgba(150,190,230,.15)", marginTop: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>常驻唤醒服务</div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>开启后后台监听唤醒词；端上模板模式需先录制 3 条</div>
          </div>
          <Switch on={wakeOn} onChange={toggleWake} label="常驻唤醒服务" />
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button type="button" style={BTN} onClick={doEnroll}>
            {templateCount > 0 ? `已录 ${templateCount}/3 条` : "录制唤醒词模板"}
          </button>
          <button type="button" style={BTN_GHOST} onClick={doClearTemplates}>清空模板</button>
        </div>
      </div>

      {/* b. 连续对话 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 4 }}>连续对话</b>
        <span style={{ fontSize: 11, color: FAINT }}>命中唤醒词后自动开麦；说完识别文本抛给聊天层，AI 回复播完自动再开麦。</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0 4px", borderTop: "1px solid rgba(150,190,230,.15)", marginTop: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>连续语音对话</div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>关闭时自动停麦、停唤醒并移除全部监听</div>
          </div>
          <Switch on={cfg.continuousDialogue} onChange={() => updateCfg({ continuousDialogue: !cfg.continuousDialogue })} label="连续语音对话" />
        </div>

        {transcript.length > 0 ? (
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 12, background: "rgba(150,190,230,.10)", maxHeight: 160, overflowY: "auto" }}>
            {transcript.map((t, i) => (
              <div key={`${t.ts}-${i}`} style={{ fontSize: 12, color: INK, padding: "3px 0", lineHeight: 1.5 }}>
                <span style={{ color: FAINT, marginRight: 6 }}>你：</span>{t.text}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...GUIDE_BOX, marginBottom: 0 }}>开启后，这里会实时显示本轮识别到的语音文本。</div>
        )}
      </div>

      {/* c. 自动朗读 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 4 }}>自动朗读</b>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0", borderBottom: "1px solid rgba(150,190,230,.15)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>朗读 AI 回复</div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>聊天层抛 float:assistant-text 时自动语音播报</div>
          </div>
          <Switch on={cfg.autoSpeak} onChange={() => updateCfg({ autoSpeak: !cfg.autoSpeak })} label="自动朗读" />
        </div>

        {/* 合成引擎：系统 TTS / MiniMax（与现实桥设置页同一份配置） */}
        <div style={{ marginTop: 12 }}>
          <i style={{ fontStyle: "normal", fontSize: 11.5, color: SUB, display: "block", marginBottom: 4 }}>合成引擎</i>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {([["system", "系统 TTS"], ["minimax", "MiniMax 在线"]] as Array<["system" | "minimax", string]>).map(([p, label]) => {
              const on = voiceCfg.provider === p;
              return (
                <button key={p} type="button" onClick={() => updateVoiceCfg({ provider: p })}
                  style={{
                    border: "none", borderRadius: 999, padding: "8px 14px", fontSize: 12, fontWeight: 700,
                    cursor: "pointer", minHeight: 40,
                    background: on ? ACCENT : "rgba(150,190,230,.15)", color: on ? "#fff" : SUB,
                  }}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {voiceCfg.provider === "minimax" ? (
          <>
            <div style={{ marginTop: 10 }}>
              <i style={{ fontStyle: "normal", fontSize: 11.5, color: SUB, display: "block", marginBottom: 4 }}>API Key（不回显完整值）</i>
              <input type="password" value={voiceCfg.apiKey} placeholder="MiniMax api key"
                onChange={e => updateVoiceCfg({ apiKey: e.target.value })} style={INPUT} />
            </div>
            <div style={{ marginTop: 10 }}>
              <i style={{ fontStyle: "normal", fontSize: 11.5, color: SUB, display: "block", marginBottom: 4 }}>音色 voiceId</i>
              <input type="text" list="hw-voice-assistant-voices" value={voiceCfg.voiceId}
                onChange={e => updateVoiceCfg({ voiceId: e.target.value })} style={INPUT} />
              <datalist id="hw-voice-assistant-voices">
                {VOICE_ASSISTANT_DEFAULT_VOICES.map(v => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </datalist>
            </div>
            <div style={{ marginTop: 10 }}>
              <i style={{ fontStyle: "normal", fontSize: 11.5, color: SUB, display: "block", marginBottom: 4 }}>接口地址 baseUrl</i>
              <input type="text" value={voiceCfg.baseUrl}
                onChange={e => updateVoiceCfg({ baseUrl: e.target.value })} style={INPUT} />
            </div>
            <div style={{ marginTop: 10 }}>
              <i style={{ fontStyle: "normal", fontSize: 11.5, color: SUB, display: "block", marginBottom: 4 }}>模型 model</i>
              <input type="text" value={voiceCfg.model} placeholder="speech-01-turbo"
                onChange={e => updateVoiceCfg({ model: e.target.value })} style={INPUT} />
            </div>
            <div style={{ fontSize: 11, color: FAINT, marginTop: 8 }}>
              语速 / 音调滑块对 MiniMax 同样生效（映射为 voice_setting.speed / pitch）。
            </div>
          </>
        ) : null}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <b style={{ fontSize: 13, color: INK }}>语速</b>
          <span style={{ fontSize: 12, color: SUB, fontVariantNumeric: "tabular-nums" }}>{cfg.rate.toFixed(1)}x</span>
        </div>
        <input type="range" min={0.5} max={2} step={0.1} value={cfg.rate} style={sliderStyle}
          onChange={e => updateCfg({ rate: Number(e.target.value) })} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
          <b style={{ fontSize: 13, color: INK }}>音调</b>
          <span style={{ fontSize: 12, color: SUB, fontVariantNumeric: "tabular-nums" }}>{cfg.pitch.toFixed(1)}</span>
        </div>
        <input type="range" min={0.5} max={2} step={0.1} value={cfg.pitch} style={sliderStyle}
          onChange={e => updateCfg({ pitch: Number(e.target.value) })} />

        <div style={{ marginTop: 12 }}>
          <i style={{ fontStyle: "normal", fontSize: 11.5, color: SUB, display: "block", marginBottom: 4 }}>测试文本</i>
          <input type="text" value={cfg.testText} onChange={e => updateCfg({ testText: e.target.value })} style={INPUT} />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" style={BTN} onClick={trySpeak}>试读</button>
        </div>
      </div>

      {/* d. P60 / HarmonyOS 保活引导 */}
      <div style={{ ...CARD, marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: INK, display: "block", marginBottom: 4 }}>真机权限与保活（P60 / HarmonyOS 3.1）</b>
        <span style={{ fontSize: 11, color: FAINT }}>常驻唤醒与后台连续对话依赖以下系统开关，需手动确认：</span>
        <div style={{ ...GUIDE_BOX, marginBottom: 0 }}>
          <div style={{ marginBottom: 6 }}>1. 麦克风权限：录音 / 语音识别必需。</div>
          <div style={{ marginBottom: 6 }}>2. 通知权限：常驻前台通知（唤醒服务保活）必需。</div>
          <div style={{ marginBottom: 6 }}>3. 设置 → 应用 → 启动管理：把本 App 设为手动管理，允许自启动 / 后台活动 / 关联启动。</div>
          <div style={{ marginBottom: 6 }}>4. 电池优化设为不限制，避免锁屏后麦克风被系统回收。</div>
          <div>5. 语音唤醒需保持前台通知常驻，划掉通知栏会停止监听。</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button type="button" style={BTN_GHOST} onClick={() => { const r = runShellAction("打开麦克风权限", s => s.openPermissionSettings?.("microphone")); if (!r.ok) onNotice?.(r.detail); }}>麦克风权限</button>
            <button type="button" style={BTN_GHOST} onClick={() => { const r = runShellAction("打开通知权限", s => s.openPermissionSettings?.("notification")); if (!r.ok) onNotice?.(r.detail); }}>通知权限</button>
            <button type="button" style={BTN_GHOST} onClick={() => { const r = runShellAction("打开应用信息页", s => s.openAppSettings?.()); if (!r.ok) onNotice?.(r.detail); }}>启动管理</button>
            <button type="button" style={BTN_GHOST} onClick={() => { const r = runShellAction("申请忽略电池优化", s => s.requestIgnoreBatteryOptimization?.()); if (!r.ok) onNotice?.(r.detail); }}>电池优化</button>
          </div>
        </div>
      </div>
    </div>
  );
}
