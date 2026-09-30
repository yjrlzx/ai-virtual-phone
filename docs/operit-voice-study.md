# Operit 语音助手配置与实现调研报告

源码根：`C:\Users\杨静茹\Desktop\Operit-main\Operit-main`。下文路径均相对该根目录，行号为该文件内实际行号。

总览：Operit 的语音链路分三层——
- 唤醒层：`AIForegroundService`（常驻前台服务）内同时跑两种唤醒后端，二选一：
  - STT 模式（默认）：端上 sherpa-mnn 流式识别不停转文字，在文本里子串匹配唤醒词；
  - PERSONAL_TEMPLATE 模式：自研轻量 MFCC+DTW 模板匹配，不做识别，只判"是不是唤醒词"。
- 对话层：唤醒命中后拉起 `FloatingChatService` 全屏语音模式（wave mode），由 `FloatingFullscreenModeViewModel` + `SpeechInteractionManager` 驱动"听→识别→发 AI→TTS→再听"闭环。
- 输出层：`VoiceService`/`VoiceServiceFactory` 抽象 10 种 TTS 后端；远端 TTS 统一走 `QueuedTtsPlayback` 双 Channel 队列；系统 TTS 自带一套 ArrayDeque 队列。

---

## 1. 语音唤醒（自定义唤醒词）

### 1.1 两种唤醒模式与配置项

唤醒模式存于 DataStore `wake_word_preferences`：

| 配置项 | key | 默认值 | 来源 |
|---|---|---|---|
| 常驻监听总开关 | `always_listening_enabled` | `false` | `data/preferences/WakeWordPreferences.kt:46,64` |
| 唤醒词文本 | `wake_phrase` | 「小欧」（`R.string.wake_word_default`） | `WakeWordPreferences.kt:47,72-75`；`res/values/strings.xml:8195` |
| 唤醒词正则开关 | `wake_phrase_regex_enabled` | `false` | `WakeWordPreferences.kt:48,63` |
| 唤醒识别模式 | `wake_recognition_mode` | `"stt"`（另一值 `"personal_template"`） | `WakeWordPreferences.kt:49,65`；枚举 `:35-38` |
| 个人唤醒模板 | `personal_wake_templates_json` | 空列表 | `WakeWordPreferences.kt:50,193-202` |
| 唤醒问候语开关/文案 | `wake_greeting_enabled` / `wake_greeting_text` | `true` / 「我在」 | `WakeWordPreferences.kt:53-54,67,76-79`；`strings.xml:8196` |
| 唤醒后空闲退出秒数 | `voice_call_inactivity_timeout_seconds` | `5`（UI 限制 1–600） | `WakeWordPreferences.kt:51-52,66`；`ui/floating/ui/fullscreen/viewmodel/FloatingFullscreenModeViewModel.kt:433` |
| 唤醒后自动新建会话 | `wake_create_new_chat_on_wake_enabled` | `false` | `WakeWordPreferences.kt:56-57,69` |

### 1.2 STT 模式怎么判唤醒

- 后台用 `SpeechServiceFactory.createWakeSpeechService()` 创建识别器：**即使用户配的是 OpenAI/Deepgram 在线 STT，唤醒场景也强制回退到端上 `SHERPA_NCNN`**（`api/speech/SpeechServiceFactory.kt:37-50`）。模型为 `sherpa-mnn-streaming-zipformer-bilingual-zh-en-2023-02-20`，int8 量化，2 线程，greedy 解码（`api/speech/SherpaMnnSpeechProvider.kt:112-163`）。端点规则：rule1 2.4s 无语音、rule2 1.2s 末端端点、rule3 单段 20s（`:144-148`）。
- 识别输出（含 partial）每帧回调里做 `matchWakePhrase`：先把识别文本和唤醒词都 `lowercase()` 并删掉所有空白/标点（`normalizeWakeText`），再 `contains` 子串包含；开正则时用 `Regex(phrase).containsMatchIn`（`api/chat/AIForegroundService.kt:1829-1855`）。
- 命中后 3 秒去抖（`lastWakeTriggerAtMs < 3000` 丢弃，`:1672-1675`），然后 `setPendingWakePhrase` 记录唤醒词原文，走 `triggerWakeLaunch()`。

### 1.3 个人模板模式：录入流程

- UI 录入三步：`AssistantConfigScreen.kt:636-659` 要求依次录 step1/2/3，三步全部非空才允许保存（`:663`），保存为固定 3 条模板写回 DataStore（`:669-673`）。
- 单次录音 `PersonalWakeEnrollment.recordOneTemplate`：16kHz 单声道 PCM16、`AudioSource.MIC`、帧长 512；VAD 用 ONNX Silero（NORMAL，speech 60ms / silence 300ms）；参数 `maxRecordMs=6000, minSpeechMs=250, endSilenceMs=350`——即 VAD 检出语音后，尾静音 350ms 即截断一条模板（`api/speech/PersonalWakeEnrollment.kt:14-88`）。
- 特征提取 `PersonalWakeFeatureExtractor.Config` 默认值（`api/speech/PersonalWakeFeatureExtractor.kt:13-23`）：16kHz、窗 400 / 帧移 160、FFT 512、40 mel 滤波、取 13 阶 MFCC、最多 64 帧、fMin 20Hz / fMax 4kHz。流程：去直流→中心化截到最近 2 秒（`:220-224`）→预加重 0.97→Hann→FFT 幅值谱→log mel→DCT 得 13 维 MFCC→加一阶差分、二阶差分拼到 **39 维/帧**→整段 CMVN 方差归一（`:29-90,164-184`）。超过 64 帧时对帧做等长池化压到 64 帧（`:92-115`）。
- 存储：特征 `FloatArray` 直接 `toList()` 序列化成 JSON 存 DataStore（`WakeWordPreferences.kt:41-43,276-281`），不做任何加密/文件存储。

### 1.4 端上检测模型与阈值

检测在 `PersonalWakeListener.runLoop`（`api/speech/PersonalWakeListener.kt`）：

- 同样 16kHz/512 帧，ONNX Silero VAD（speech 30ms / silence 300ms，`:72-79`）切出语音段：`minSegmentMs=250`、`maxSegmentMs=1600`、尾静音 350ms（`:27-29`）。
- 每段先过 **RMS 噪声门**：门限 = `max(0.003, 噪声RMS_EMA + 0.001)`，噪声 EMA 系数 0.05（`:39-41,104-113,185-192`）。
- 特征帧逐帧 L2 归一后，与每条模板做 **Sakoe-Chiba band=4 的 DTW**，帧间代价用余弦距离，相似度 = `1 - 平均代价/2` 截到 [0,1]（`:344-366`）。
- 判定阈值（`Config` 默认值，`:24-43`）：
  - 静态阈值 `similarityThreshold = 0.865`；
  - **动态阈值** = `max(0.84, min(0.865, 模板间最小相似度 - 0.02))`——用录入三条模板互相 DTW 的一致性自适应收紧/放宽（`:226-257`）；
  - 模板间一致性低于 `minIntraSimilarity=0.80` 只打警告不拦截（`:236-240`）；
  - 时长比窗 `[0.75, 1.25]`（命中段帧数 / 模板平均帧数，`:242-249`）；
  - `requiredTemplateMatches=1`：与至少 1 条模板相似度 ≥ 动态阈值即可，但多模板时要求「≥2 条命中」或「最佳与次佳差 ≤ 0.04」防误触（`:275-279`）；
  - 服务层再加 3 秒去抖（`AIForegroundService.kt:1708-1711`）。

### 1.5 唤醒前后的音频预滚动（preroll）

- `SpeechPrerollStore` 是一个 16kHz、容量 2500ms 的环形 buffer，唤醒监听循环每一帧都往里 `appendPcm`（`api/speech/SpeechPrerollStore.kt:13-19,32-46`；`PersonalWakeListener.kt:99`；`SherpaMnnSpeechProvider.kt:394`）。
- 命中唤醒词时并不立刻停监听，而是打标记 `wakeHandoffPending`，由 `ACTION_PREPARE_WAKE_HANDOFF` 计算一个动态窗口 `windowMs = (命中后已耗时 + 已耗时/4，夹在 200–2500ms)`，`capturePending(windowMs)` + `armPending()`（`AIForegroundService.kt:1199-1230`；`SpeechPrerollStore.kt:48-103`）。
- 新识别会话 `startRecognition` 时 `consumePending()` 把这段预录音直接喂进 sherpa stream（`SherpaMnnSpeechProvider.kt:308-325`）——**用户在唤醒词后面紧接着说的指令不会因为"停旧监听→起新监听"的间隙丢掉**。
- 唤醒词原文也通过 `setPendingWakePhrase`/`consumePendingWakePhrase` 带过去，新会话开头把它从识别文本里剥掉（`SpeechPrerollStore.kt:105-130`；`ui/floating/voice/SpeechInteractionManager.kt:135,243-276`）。

---

## 2. 连续语音对话

### 2.1 唤醒后如何进入连续对话

- 命中后 `triggerWakeLaunch()` 直接 `startForegroundService(FloatingChatService)`，带三个 extra：`INITIAL_MODE=FULLSCREEN`、`EXTRA_AUTO_ENTER_VOICE_CHAT=true`、`EXTRA_WAKE_LAUNCHED=true`（`AIForegroundService.kt:1810-1827`）。桌面小部件点击也是同一条路径，只是不带 `WAKE_LAUNCHED`（`widget/VoiceAssistantGlanceWidget.kt:67-80`）。
- `FloatingChatService.onStartCommand` 置 `autoEnterVoiceChat`，并在全屏模式下通知 `AIForegroundService` 暂停后台唤醒监听（`services/FloatingChatService.kt:416-427`；`AIForegroundService.kt:1193-1197`）。
- 全屏 ViewModel `initialize(autoEnterVoiceChat, wakeLaunched)` → `enterWaveMode(wakeLaunched, enableAutoTimeout=true)`（`FloatingFullscreenModeViewModel.kt:427-455`）。`enterWaveMode` 先播唤醒问候语（与录音并行，全双工，问候期间 1200ms 内的识别结果被 `suppressRecognitionUntilMs` 抑制，`:30,372-389,414-417`），然后 `startVoiceCapture()`。

### 2.2 一轮对话的状态机

闭环由三处协作完成：

```
LISTEN (startListening, continuousMode=true)
  └─ partial 文本到达 → 2s 静默定时器重置（autoSendSilence，wave 模式才开）
        → finalizeSpeechInput() → onSpeechResult(文本)
              ├─ prepareVoiceCaptureForAiTurn(): 停录音，标 shouldResume
              ├─ onSendMessage(text, VOICE)
              └─ awaitAiTurnAndResumeVoiceCapture(): 轮询 isAiBusy||isSpeaking
                    观察到 busy=true→false 后 → startVoiceCapture() 回到 LISTEN
```

- 监听启动：`SpeechInteractionManager.startListening` 先 `AIForegroundService.ensureMicrophoneForeground(forceStart=true)`，再发 `ACTION_PREPARE_WAKE_HANDOFF` 让后台停唤醒监听；`delay(180)` 后以**最多 12 次 × 160ms 重试**起 `startRecognition(zh-CN, continuousMode=true, partialResults=true)`，专门解决两个录音器抢麦（`ui/floating/voice/SpeechInteractionManager.kt:139-184`）。
- 自动断句：wave 模式 `autoSendSilence=true`，每来一个非空 partial 就重启 2000ms 静默计时器，到时即 `finalizeSpeechInput()` 发送（`SpeechInteractionManager.kt:225-232`）；手动模式下 `stopListening` 后还有 3000ms fallback 超时兜底（`:204-209,278-286`）。
- AI 回答边流式边读：`handleStreamResponse` 逐字累积，`TtsSegmenter.nextSegmentEnd` 一切到句尾就 `enqueueSpeak`，第一句带上麦抑制 1200ms（`FloatingFullscreenModeViewModel.kt:239-261,280-283`）。
- 朗读期间不抢麦：`awaitAiTurnAndResumeVoiceCapture` 等到 `isAiBusy()||voiceService.isSpeaking` 从 true 变 false 才重新 `startVoiceCapture()`（`:154-178`）。
- 用户插话：点中央头像在 AI 忙/朗读时会取消 AI、停 TTS、立刻重新 `startVoiceCapture()`（`:391-405`）。

### 2.3 怎么退出

- 空闲退出：`startInactivityMonitor` 每 500ms 检查 `lastVoiceActivityAtMs`，超过 `inactivityTimeoutSeconds`（默认 5s）：
  - 若 TTS 还在读，最多等 20s 读完后**重置计时**而不是退出（`:488-499`）；
  - 若 AI 还在工具调用/生成，忙完后**重置计时**（`:503-510`）；
  - 真空闲 → `exitWaveMode()`；若是唤醒拉起的，再 `onClose()` 整个悬浮窗（`:512-515`）。
- `exitWaveMode()`：停录音、停 TTS、清抑制标记、复位头像（`:357-370`）。
- 悬浮窗关后，`AIForegroundService.scheduleWakeResume()` 检测到 `FloatingChatService.getInstance()==null` 即恢复后台唤醒监听（`AIForegroundService.kt:1773-1808`）。

---

## 3. 后台唤醒保活

### 3.1 服务与通知渠道

- 主服务 `AIForegroundService`：渠道 `AI_SERVICE_CHANNEL`，`IMPORTANCE_LOW`，通知常驻（`setOngoing(true)`），NOTIFICATION_ID=1（`api/chat/AIForegroundService.kt:107,1306-1321,1903-1908`）。通知上挂 4 个动作：打开语音悬浮窗、开关唤醒监听、退出 App、取消当前任务（`:1947-2016`）。
- 悬浮窗服务 `FloatingChatService`：独立渠道 `floating_chat_channel`，LOW 重要性，ID=1001，`CATEGORY_SERVICE`（`services/FloatingChatService.kt:64-65,346-370`）。
- 两个服务 `onCreate` 都走 `ForegroundServiceCompat.startForeground(..., types=DATA_SYNC)`（`AIForegroundService.kt:933-941`；`FloatingChatService.kt:301-306`；`core/application/ForegroundServiceCompat.kt:10-35`）。

### 3.2 锁屏/灭屏保活与麦克风前台类型

- Android 14+（UPSIDE_DOWN_CAKE）开始监听唤醒时调 `tryPromoteToMicrophoneForeground()` 把前台服务类型升级为 `DATA_SYNC | MICROPHONE`；但**强约束：必须 App 当前在前台**（最多等 3.5s 等 Activity 出现，没有就放弃提升）（`AIForegroundService.kt:1051-1080,1584-1586`）。
- `FloatingChatService` 在 `onStartCommand` 里申请 `PARTIAL_WAKE_LOCK`（tag `OperitApp:FloatingChatServiceWakeLock`，reference-counted=false，10 分钟超时自动释放）（`FloatingChatService.kt:315-333,395`）。
- 一个 1×1px、全透明、`FLAG_NOT_FOCUSABLE|NOT_TOUCHABLE` 的 `TYPE_APPLICATION_OVERLAY` 保活悬浮 View：常驻时挂着（配合 `SYSTEM_ALERT_WINDOW` 权限），并借它的 WindowInsets 监听 IME 弹出（`AIForegroundService.kt:1461-1512`；权限声明 `AndroidManifest.xml:25`）。
- 服务空闲自毁：`stopSelfIfIdle` 在「AI 不忙 && 未开常驻监听 && 未开后台保活 && 无外部 HTTP」时主动 `stopForeground`+`stopSelf`（`:903-922`）。

### 3.3 权限与麦克风仲裁

- Manifest 声明：`RECORD_AUDIO`、`FOREGROUND_SERVICE(_MICROPHONE/_DATA_SYNC/_SPECIAL_USE/_MEDIA_PROJECTION/_SHORT_SERVICE)`、`SYSTEM_ALERT_WINDOW`、`POST_NOTIFICATIONS`、`WAKE_LOCK`（`AndroidManifest.xml:15-63`）。
- 起监听前查 `RECORD_AUDIO`，没授权就自动把 `always_listening_enabled` 写回 false 并提示（`AIForegroundService.kt:1569-1582`）。
- **麦克风抢占仲裁**：注册 `AudioManager.registerAudioRecordingCallback`（API 29+），枚举 `activeRecordingConfigurations`，按 uid/pkg 排除自己；发现别的 App 在录音就 `updateWakeListeningSuspendedForExternalRecording(true)` 停唤醒，对方停了再恢复（`:569-690`）。
- 另外两类挂起条件：IME 弹出（由 1px overlay 的 insets 回调驱动，`:520-525,1471-1480`）、全屏语音窗打开（`:534-539`）。三者合成 `shouldListen = enabled && !suspendedIme && !suspendedExternal && !suspendedFullscreen`（`:551-567`）。

---

## 4. 自动朗读（TTS 抽象层）

### 4.1 引擎抽象与 Provider 清单

`VoiceService` 接口（`api/voice/VoiceService.kt`）：`speak(text, interrupt=true, rate, pitch, extraParams)`、`stop/pause/resume`、`speakingStateFlow`、`getAvailableVoices/setVoice`。

`VoiceServiceFactory.VoiceServiceType` 共 10 种（`api/voice/VoiceServiceFactory.kt:10-28`）：

| 类型 | 实现 | 说明 |
|---|---|---|
| `SIMPLE_TTS`（**默认**） | `SimpleVoiceProvider`（在 `api/voice/AccessibilityVoiceProvider.kt:27`） | 安卓系统 `TextToSpeech` |
| `HTTP_TTS` | `HttpVoiceProvider` | 自托管 HTTP TTS，URL/body 模板 + 响应管道 |
| `OPENAI_WS_TTS` | `OpenAIRealtimeVoiceProvider` | OpenAI Realtime WebSocket |
| `SILICONFLOW_TTS` / `MINIMAX_TTS` / `MIMO_TTS` / `DOUBAO_TTS` / `OPENAI_TTS` | 同名 Provider | 各家云 TTS |
| `VITS_TTS` | `VitsVoiceProvider` | 端上 VITS/Piper ONNX |

默认值：`DEFAULT_TTS_SERVICE_TYPE = SIMPLE_TTS`、语速/音调均 `1.0`（`data/preferences/SpeechServicesPreferences.kt:77,80-81`）。工厂按 profile id 缓存单例，切 profile 即 `shutdown` 重建（`VoiceServiceFactory.kt:121-138`）。

### 4.2 长文本切分与清洗

- 切分 `util/TtsSegmenter.kt`：句末符集 `!?;:。！？；：\n`；`.` 只有在后一个字符不是数字也不是 `.` 时才算句末（避免把 `3.14`、省略号切断，`:45-57`）；找不到句末符就硬切到 `MAX_SEGMENT_LENGTH = 50` 字（`:4,23`）。流式场景用 `nextSegmentEnd(buffer)` 增量切（`:14-25`）。
- 清洗 `util/TtsCleaner.kt`：按用户配的正则列表逐个 `replace`，默认两条——去掉英文括号和中文括号内容（`\([^)]+\)`、`（[^）]+）`，`SpeechServicesPreferences.kt:106-109`；`TtsCleaner.kt:40-70`）；之后再过一道 `WaifuMessageProcessor.cleanContentForWaifu`（去头像标签等，`SpeechInteractionManager.kt:319-321`）。
- 链路：AI 流字符 → 累积 → `nextSegmentEnd` 切句 → `cleanTextForTts` → `enqueueSpeak`（`FloatingFullscreenModeViewModel.kt:239-287`）。

### 4.3 朗读开关

- wave 模式下 AI 消息默认自动朗读（`processAndSpeakAiMessage` 对 `"ai"` 消息分支走 speak，`:214-234`）；`isStreamingTtsMuted` 可静音，静音时只在非 wave 模式跳过 speak，wave 模式点中央头像仍可打断（`:123-128,277`）。

---

## 5. TTS 队列：QueuedTtsPlayback 的队列语义

`api/voice/QueuedTtsPlayback.kt` 是远端/云端 TTS 的统一播放管线（仅 `HttpVoiceProvider.kt:76-79` 使用；系统 TTS 自己另写了一套）。

### 5.1 双阶段流水线

- 两个协程 + 两个 Channel（`:41-43`）：
  - `speakQueue = Channel<Request>(UNLIMITED)`：文本请求无界入队；
  - 生产协程逐个 `prepareAudioFile(request)`（即 HTTP 合成音频落盘），成功后塞进 `playbackQueue = Channel<PreparedRequest>(capacity=1)`——**只缓冲一个已合成文件，起到"预取下一句"的效果**（`:53-79`）。
  - 消费协程从 `playbackQueue` 取出，用 `MediaPlayer` 播本地文件，播完才 `complete(completion)`（`:69-78,207-267`）。
- `speak()` 是挂起函数，`send` 进队后 `completion.await()`，即调用方会一直等到这段音频真播完（`:81-103`）。

### 5.2 打断/清空/代际（generation）

- 每段请求带一个 `generation = stopGeneration.get()`（`:98`）。任何 `stop()`/`interrupt`/`shutdown` 都 `stopGeneration.incrementAndGet()`，于是：
  - 已在 `speakQueue` 排队还没合成的 → `clearPendingRequests` 全部 `complete(false)`（`:168-173`）；
  - 已合成躺在 `playbackQueue` 里的 → `clearPendingPlayback` 全部 `complete(false)`（`:175-180`）；
  - 正在播的 → `stopPlaybackOnly()` 停 MediaPlayer（`:190-205`）；
  - 已经在飞、还没轮到播的请求，到 `playPreparedRequest` 时 `isCurrent()` 失败直接丢弃（`:164-166,207-210`）。
- `speak(interrupt=true)` = 先 `clearForInterrupt()`（等价 stop，再入新请求，`:88-90,182-188`）；`interrupt=false` = 直接入队尾部，排队合成、排队播放。这正好对应流式 TTS 的用法：第一句 `interrupt=true`（打断上一轮），后续句子 `interrupt=false` 排队跟读（`FloatingFullscreenModeViewModel.kt:289-307`）。
- `pause()`/`resume()` 直接对当前 MediaPlayer 操作，并用 `isPaused` 标记让轮询循环挂起（`:113-145,243-247`）。
- 音频属性：`CONTENT_TYPE_SPEECH | USAGE_MEDIA`，每播一个文件新建 MediaPlayer，finally 里 stop+release（`:225-266`）。

### 5.3 前后台切换

- 队列本身跑在 `Dispatchers.IO` + `SupervisorJob`，与 UI 生命周期无关；服务 `shutdown()` 才 `scope.cancel()` 并关两个 Channel（`:147-162`）。
- 朗读状态通过 `speakingStateFlow` 暴露：连续对话的"AI 说完了再听"轮询（`FloatingFullscreenModeViewModel.kt:160-176`）和空闲退出时"朗读中不退出、读完再算"（`:491-499`）都消费这个 Flow。
- 对照：`SimpleVoiceProvider`（系统 TTS）没用 QueuedTtsPlayback，而是 `ArrayDeque<PendingUtterance>` + `QUEUE_FLUSH/QUEUE_ADD`，并在 pause 时通过 `onRangeStart` 记住当前 utterance 的播放偏移，把"当前句剩余部分 + 后续队列"拼成 `pausedSegments`，resume 时从头 FLUSH 重放（`AccessibilityVoiceProvider.kt:101-128,396-553`）。

---

## 6. 对照 float 项目：Operit 有而 float 还缺的设计点（按吸收优先级排序）

float 现状（hint）：`WakeWordService`（系统 SpeechRecognizer 文本匹配 / on_device 走 `WakeWordDetector` 的 MFCC+DTW，SharedPreferences 存最多 3 条模板）、`ShellStt`（系统识别 + 在线 Whisper），JS 桥 `startListening/stopListening/startWakeWord/...`，base64 UTF-8 evaluateJavascript 回调；**缺 TTS 队列与连续对话闭环**。

1. **流式 TTS 朗读队列**：双 Channel（无界合成队列 + 容量 1 预取播放队列）+ generation 代际打断 + `CONTENT_TYPE_SPEECH` MediaPlayer——float 目前完全没有 TTS 播放侧，应最先补。
2. **边接收边朗读的流式分句**：`TtsSegmenter` 按中英文句末符增量切、50 字硬上限、小数点/省略号不误切，配合 AI stream 逐字累积——直接决定首字延迟。
3. **连续对话状态机**：听→发 AI→读→等 `isSpeaking` 变 false 再自动开下一轮听；2s 静默自动发送；5s 不活跃退出且朗读/AI 忙时重置计时不退出。
4. **唤醒预滚动环形 buffer（2.5s）**：命中后把唤醒词后紧跟着的指令音一并喂给识别器，解决"喊完名字的前半句话被吃掉"。
5. **唤醒→对话的麦克风交接握手**：停旧唤醒识别器→按命中后已耗时动态算 preroll 窗口→新识别器 consume→起识别失败 12×160ms 重试抢麦。
6. **唤醒后命令文本剥前缀**：把识别结果开头的唤醒词（支持自定义/正则）剥掉再发给 AI。
7. **麦克风抢占仲裁**：`AudioManager.AudioRecordingCallback` 检测其他 App 录音自动停唤醒、对方停了自动恢复；IME 弹出/全屏语音时也挂起。
8. **前台服务分级与保活**：常驻 `DATA_SYNC` 通知渠道（LOW 重要性）、Android 14+ 条件升级 `FOREGROUND_SERVICE_TYPE_MICROPHONE`（且要求 App 在前台）、对话期间 `PARTIAL_WAKE_LOCK`（10min 超时）、1px 透明 overlay 保活兼监听 IME。
9. **个人唤醒的工程化阈值**：动态阈值（模板间一致性 -0.02，兜底 0.84）、时长比窗 0.75–1.25、RMS 噪声 EMA 门、最佳/次最佳 DTW 相似度差 ≤0.04 的二选一防误触、3s 触发去抖。
10. **TTS 文本清洗**：用户可配正则（默认去中英文括号注释），朗读前再过一遍消息后处理。
11. **通知栏快捷动作**：常驻通知上直接挂"打开语音助手 / 开关唤醒 / 退出"按钮，以及桌面 Glance 小部件一键拉起全屏语音。
12. **唤醒问候语与首句麦抑制**：问候 TTS 与录音并行（全双工），但问候后 1.2s 内的识别结果丢弃，避免把自己的问候声识别成输入。
