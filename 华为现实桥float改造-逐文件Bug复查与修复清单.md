# 华为现实桥 float 改造 · 逐文件 Bug 复查与修复清单

复查时间：2026-09-29
复查方式：A/C/D 类逐文件仔细读 + 修复写回；B 类以现行文件为准（并行代理仍在补 5 新能力，已接入 15 工具查干净）。
验证：**npm run build 已通过**（含 weixin-dist / push-dist / next build 71 页 / restore-backdrop-filter，退出码 0）。

---

## 〇、总体结论

- 已修复 bug：Kotlin 侧 19 处（线程 5 + 错误 JSON 转义 21 处含并行代理新方法 8 处、截图 recycle、token 复用、防御性 clamp、manifest 权限）、lifeline/记账 3 处（记账 getPayments 解包+参数、CSS 引号损坏 2 处）、网页截图死链路 1 处（新增回调实现）。
- 15 个已接入华为工具：三重名单（定义/识别/执行 case/桥方法）完全闭合，usage guide 与 schema JSON 全部合法，与 Kotlin 桥字段契约逐一对齐，无功能性 bug。
- 去重：华为启用时在注入层排除 iOS 现实桥的逻辑在位且只作用于注入层；静态子工具零撞名。
- 硬编码死数据专项：无写死的城市坐标/token/密钥；支付来源包名双侧不一致（Kotlin 收 6 个、网页只分微信/支付宝）是唯一需修项（建议方案见 D-1）。
- 未闭环（诚实声明）：并行代理的 5 新能力执行分支未接完；Android 14+ 的 mediaProjection 前台服务未建；读取文件工具缺存储权限（分区存储限制）。详见「七、未闭环与后续项」。

---

## 一、A 类 · 华为壳 Kotlin 原生层（无安卓编译环境，严格代码审查 + 修复写回）

### 1. android-shell\...\shell\MainActivity.kt（JS 桥全集 window.AndroidShell）

| # | 位置 | 是什么 bug | 怎么修 | 状态 |
|---|------|-----------|--------|------|
| A-1 | captureScreen() → requestScreenCapture() → screenCaptureLauncher.launch() | @JavascriptInterface 跑在 WebView JavaBridge 线程，ActivityResultLauncher.launch 必须在主线程，否则运行时崩溃/结果不回传 | runOnUiThread 包裹（onNewIntent 主线程路径自动内联，双调用方安全） | 已修 |
| A-2 | getLocation() 里 locationPermissionLauncher.launch() | 同上，权限请求 launcher 在 JavaBridge 线程拉起必崩 | runOnUiThread { runCatching {...} } | 已修 |
| A-3 | openAppSettings() 直接 startActivity | JavaBridge 线程拉起系统设置页，EMUI 对非 UI 线程起 Activity 敏感 | 整体包进 runOnUiThread | 已修 |
| A-4 | requestIgnoreBatteryOptimization() 直接 startActivity | 同上 | 整体包进 runOnUiThread | 已修 |
| A-5 | openApp(pkg) 直接 startActivity | 同上；且原 try/catch 包住 startActivity，切主线程后异常无法原位捕获 | getLaunchIntentForPackage 留原线程，startActivity 移入 runOnUiThread { runCatching } | 已修 |
| A-6 | 全文件 13+1 处 """{"ok":false,"error":"${t.message}"}""" 裸拼接 | 异常 message 含双引号/反斜杠/换行即产出非法 JSON，网页 JSON.parse 失败 | 新增 errJson()（JSONObject.quote 转义），全部替换 | 已修 |
| A-7 | 并行代理新写的 8 个方法（getDeviceInfo/setVolume/setBrightness/readClipboard/writeClipboard/openUrl/readFile/runShellCommand）内同样裸拼 "${it.message}" | 同上（6 处 getOrElse + 相关） | 统一替换为 errJson(it.message) | 已修 |
| A-8 | 同上 8 方法里 setBrightness 未授权分支、openUrl 直接 startActivity | JavaBridge 线程起 Activity | 两处 startActivity 均包 runOnUiThread { runCatching } | 已修 |
| A-9 | deliverToWeb 调 window.__floatBridgeOnScreenShot | 见 C-4：网页侧原本无此回调（死链路），已由网页侧补实现 | 网页侧 mascot-chat-room.tsx 注册接收端（见 C-4） | 已修（双侧闭环） |
| A-10 | companion VERSION="1.0.0" 与 build.gradle versionName 双写 | 版本号两处维护易失步 | 建议 VERSION 改读 BuildConfig.VERSION_NAME | 记录，未改（无害） |

补充确认（无需改）：webPermissionLauncher/fileChooserLauncher/notifPermissionLauncher 均由主线程回调触发；companion.activeActivity 可见性合法；JSONObject(Map) 构造器签名命中。

### 2. RealityBridgeAccessibility.kt

| # | 位置 | 是什么 bug | 怎么修 | 状态 |
|---|------|-----------|--------|------|
| A-11 | setFocusMode(durationMin) 仅判 >0 无上限 | 异常入参可把锁定拉到数天 | durationMin.coerceIn(0,240)（0/负值=关闭） | 已修 |
| A-12 | screenBreak(seconds) 仅判 <=0 无上限 | 超长入参挂超长 sleep 线程 | seconds.coerceAtMost(3600) 后再 sleep | 已修 |

补充确认：全部对外符号（clickText/inputText/dumpScreenTree/longPressCoordinate/swipeCoordinate/pressKey/foregroundApp/screenBreak/setLockedPackages/getLockedPackages/setFocusMode/isFocusing/active/current）存在且签名匹配；dumpScreenTree 自带 jsonStr 转义；门禁 1.5s 冷却、专注不锁壳自身逻辑正确。

### 3. MediaProjectionCapture.kt

| # | 位置 | 是什么 bug | 怎么修 | 状态 |
|---|------|-----------|--------|------|
| A-13 | 取帧回调内 image.close(); bitmap.recycle(); post(cropped) | cropped 与 bitmap 共享像素后备，recycle 后回传网页的是已回收位图，compress 抛异常被 runCatching 吞掉——**截图实际永远发不到网页** | 删除 bitmap.recycle()，加注释说明共享像素 | 已修 |
| A-14 | capture 每次结束 release() 调 projection.stop() | 授权 token 一次性，stop 后同 token 不可再用；悬浮球双击用一次后永久失灵且不重弹授权 | 重写生命周期：projection 跨次复用、单次只释放 VirtualDisplay/ImageReader；新增 needsReauth 标记、busy 并发锁、obtainProjection()、registerCallback(onStop 清空并置 reauth)；createVirtualDisplay 抛错走 releaseProjectionHard | 已修（第二轮） |

已知取舍（记录）：projection 常驻复用期间系统状态栏保留录屏图标，直到用户手动停止或进程死亡。

### 4. RealityBridgeFloatingService.kt

| # | 位置 | 是什么 bug | 怎么修 | 状态 |
|---|------|-----------|--------|------|
| A-15 | onDoubleTap() 的 capture 回调 | 截图失败时（投影空/失效）无任何处理，双击静默失灵 | 回调区分：bitmap 非空→deliverScreenShotToWeb；null 且 needsReauth→MainActivity.requestScreenCaptureForFloatingBall() 弹系统授权；busy 导致的 null 直接忽略 | 已修（第二轮） |

补充确认：start/canDrawOverlays 签名匹配；startForeground 在 onCreate 内 SDK≥26 路径正确；缺悬浮窗权限时引导 + stopSelf 正确。

### 5. RealityBridgeNotificationListener.kt

逐行复查无编译级错误：RealityBridgeNotificationStore（object）定义在本文件内，MainActivity 的 snapshot(limit)/payments(limit) 匹配；缓存以 sbn.key 去重 FIFO 上限 200；snapshot clamp(1,200)、payments 至少 1；jsonStr() 已转义；onListenerConnected 回灌 activeNotifications（判 SDK≥23）正确。

### 6. AndroidManifest.xml

| # | 位置 | 是什么 bug | 怎么修 | 状态 |
|---|------|-----------|--------|------|
| A-16 | uses-permission 区 | targetSdk 34 下 MediaProjection 必须声明 FOREGROUND_SERVICE_MEDIA_PROJECTION，缺失则 getMediaProjection 直接 SecurityException | 新增该权限行 | 已修 |

组件声明核对（无需改）：AccessibilityService（exported=false+BIND_ACCESSIBILITY_SERVICE+meta-data）、NotificationListenerService（exported=false+BIND_NOTIFICATION_LISTENER_SERVICE）、FloatingService（exported=false+specialUse+对应权限）、MainActivity（exported=true LAUNCHER 必需、singleTask）全部齐全。

### 7. accessibility_service_config.xml / strings.xml / build.gradle

逐行核对无问题：事件类型/反馈/手势/取窗口内容/键过滤/description/settingsActivity 齐全；app_name 与 accessibility_service_desc 无缺失引用；gradle minSdk 26 / targetSdk 34 / compileSdk 34，SITE_URL 环境变量注入。

---

## 二、B 类 · 网页侧华为工具（15 个已接入工具查干净；并行代理半成品未动）

### 1. lib\internal-capability-storage.ts（华为段）

- 机制符合性 ✓：HUAWEI_SHELL_CAPABILITY_ID="huawei_shell_control"、能力卡片、getInternalCapabilityToolDefinition 返回 buildHuaweiShellUsageGuide()、子工具查找链 find(name)、findEnabledInternalSubToolDefinition 全部正确。
- 三重名单 ✓：15 个工具名在 HUAWEI_SHELL_SUBTOOLS ↔ isHuaweiShellToolName ↔ executeHuaweiShellTool case 完全一一对应（脚本集合比对，非手数），无缺失/多出/拼写不一致。
- usage guide JSON ✓：15 条示例动作参数还原 \" 后全部 JSON.parse 通过；12 个 HUAWEI_*_PARAMETER_SCHEMA 全部合法——**之前双引号嵌套导致 build 失败的问题无复发**。
- 去重 ✓：getEnabledInternalCapabilities 约 1314 行"华为启用时剔除 REALITY_BRIDGE_CAPABILITY_ID"存在，且仅作用于注入层，能力卡片/设置页不动；15 工具名与便签墙/音乐/日历/本地资料库/工具箱/现实桥静态名零撞名。
- 描述质量：{{user}} 占位符全部规范（Q 项改进建议见 D-2）。

### 2. lib\tool-executor.ts（华为段）

- 15 个 huawei*Tool 逐函数核对：参数读取、设置默认值回退、clamp、invokeShellJson、返回结构均正确。
- 重点：查看记账 sync+fallback（Math.max(limit,30) 拉通知去重落账，失败有缓存仍展示、空账本文案区分 all/wechat/alipay）；读取微信消息 filter(pkg===com.tencent.mm) 正确；发送提醒 openApp 空串经 Kotlin isNullOrBlank 安全；查询位置与实时天气共用 getLocation 一致。
- Kotlin 桥字段契约逐一对齐：getStatus→battery/volume/network/accessibility/floating/lockedApps；getNotifications→{pkg,title,text,ts}；getPayments→{pkg,amount,merchant,title,ts}；getLocation→{lat,lng}。
- 无害死代码 2 处（记录，未改——文件曾被并行代理热写）：huaweiPaymentsTool 内未使用的 sourceLabel；import 了未直接引用的 ALIPAY_PACKAGE。清理方法：删 sourceLabel 行、import 改 `{ WECHAT_PACKAGE, type PaymentSource }`。

### 3. lib\huawei-shell\storage.ts / types.ts

- 存储键（settings v1 / ledger v1）、账本契约（appId=ledger/collection=ledger/records）与 packages/ledger manifest 及 ledger-storage.js 完全一致（C 类核对通过）；包名常量 WECHAT_PACKAGE/ALIPAY_PACKAGE 与 Kotlin PAY_PACKAGES 前两项一致。
- 天气 URL 为设置页可配置模板（{lat}{lng}{key} 占位符，open-meteo 免费默认）；默认值（专注 25 分/息屏 60 秒/通知 10 条/记账 20 条/来源 all）全部在设置页可改。
- 9 项设置与设置页控件、load/save 契约一致，updateSettings 用 {...prev,...patch} 展开保存，不丢字段。

### 4. 设置页接入（huawei-shell-settings.tsx / phone-settings-app.tsx / toolbox-settings.tsx / globals.css / styles/huawei-shell.css）

- 挂载走 float 既有机制：phone-settings-app 的 SETTINGS_MENU 加 huaweiShell 条目 + FeaturedCard + renderSubPage；toolbox-settings 把 HUAWEI_SHELL_CAPABILITY_ID 设为默认 auto；CSS 在 globals.css @import，Y2K 冰蓝磨砂玻璃大圆角老式 Mac 三色点窗口风格，贴合 float 壳子。
- 本轮我修掉一处编译级 bug：huawei-shell-settings.tsx 的 import 里 loadHuaweiShellSettings 被导入两次（并行代理热写时产生），next build 报重复标识符——删掉重复项（已修，随 build 验证）。

### 5. 并行代理半成品（B 报告 §7，本次刻意未动）

types.ts 新增 8 个桥方法声明（getDeviceInfo/setVolume/setBrightness/readClipboard/writeClipboard/openUrl/runShellCommand/readFile，其中 5 个能力）+ 自定义动作/触发规则类型；storage.ts 新增 customActions/triggerRules 存取；internal-capability-storage.ts SUBTOOLS 已增至 22（多 7 个新工具定义+schema+usage guide）；tool-executor.ts isHuaweiShellToolName 已挂自定义动作、switch default 走 executeHuaweiCustomAction。
**未闭环点**：7 个静态新工具名尚不在 isHuaweiShellToolName 静态名单、无独立 switch case（default 只匹配用户自定义动作）——执行分支由并行代理补，我未接，避免冲突。build 通过说明当前半成品状态编译无碍。

---

## 三、C 类 · lifeline 与记账（含宿主转发）

### 1. packages\lifeline\build\dist-ledger\ledger-storage.js

| # | 位置 | 是什么 bug | 怎么修 | 状态 |
|---|------|-----------|--------|------|
| C-1 | getPayments（原 152-161 行） | 宿主 getCustomAppPayments 返回 {ok, payments:[...]}，原代码把对象当数组 .map()，点「拉取支付通知自动入账」必 TypeError——**华为工具落账在记账应用侧永远拉不出来** | .then 里解包 res.payments（兼容裸数组，异常返回 []） | 已修（node --check 通过） |
| C-2 | 同上 | limit 传裸数字，宿主桥约定 payload 为对象 {limit:n}，limit 永远回落默认 50 | 改 AiPhone.reality.getPayments({ limit: limit || 50 }) | 已修 |

修复后链路：ledger 应用 getPayments(50) → reality.getPayments({limit:50}) → 宿主 getCustomAppPayments 读 record.limit=50 → AndroidShell.getPayments(50) → {ok,payments} → 应用解包成数组。✓

### 2. packages\lifeline\mobile-enhance.js

| # | 位置 | 是什么 bug | 怎么修 | 状态 |
|---|------|-----------|--------|------|
| C-3 | 第 64、71 行 content: '… !important; | CSS 字符串闭引号丢失（箭头字符转码损坏），未闭合的 content 吞掉后续 position/right/top/transform 声明，侧栏导航分组箭头定位失效 | 两处改 content: '' !important;，保留 UTF-8 BOM | 已修（node --check 通过），并已同步复制到 build\dist-lifeline\（哈希一致） |

记录（历史遗留，非本次改造引入）：文件中文整体双重编码损坏（注释/按钮文案乱码，不影响 JS 逻辑）；805/846 行快速面板「拍小票/语音记账」仍写 lifeline 老账本（method 字段），与独立记账应用方向不一致——建议后续废弃或改跳转 ledger。

### 3. packages\lifeline\float-storage-shim.js / sync-inject.js / help-inject.js

无 bug：localStorage→float db 桥接（collection=lifeline，DB_KEY=lifeLineState_v2 三处一致，create 失败退化 update）；注入顺序 shim(第 4 行)→主体→mobile-enhance→sync-inject→help-inject 符合约定；sync-inject 绑定 shim 代理对象后先写 db 再云端 push；pullFromCloud 的 reload 与 shim 的 alreadyReloaded 防死循环；help-inject 第 76 行已写「记账→请打开独立记账应用」。R3 理论竞态（preload 往返前 setItem 空状态覆盖）概率极低且有 window.name 防死循环补偿，记录未改。

### 4. packages\lifeline\index.html

注入顺序正确；katex 重复 `<script>` 约 60 次（每个公式块插一次）——死代码，浏览器缓存同 URL 不报错，构建产物 dist-lifeline 已自动去重为 1 次，运行时无实际影响（记录）。

### 5. components\app-market\custom-app-runner.tsx + lib\custom-app-host-api.ts

git diff 确认宿主改动仅 3 处纯新增（import getCustomAppPayments、注入桥 reality.getPayments、action 分发 reality.getPayments→getCustomAppPayments(record)），未动 Kotlin、未动其它 action 逻辑；host-api 仅纯新增 getCustomAppPayments（+23 行：limit=clamp(Number(record.limit)||50,1,200)，读 AndroidShell.getPayments，返回 {ok,payments}/{ok:false,reason}）。db 转发以 app.id=ledger 命名空间读 collection=ledger，与华为工具侧同源。

### 6. 记账存储契约核对

manifest id=ledger ✓、collection=ledger ✓、records 行 id ✓、行结构 {id,value:<JSON字符串>} ✓、字段（id/date/type=expense/amount/category/note/merchant/source/auto）逐项与 lib\huawei-shell\storage.ts 对齐 ✓、包名映射 com.tencent.mm→wechat、com.eg.android.AlipayGphone→alipay 与 types.ts 一致 ✓、微信/支付宝按 source 分账 ✓。**结论：华为工具与独立记账应用读写同一份数据，无双套键名。** C-1/C-2 修复后应用侧才能真正拉到华为壳推送的支付通知。

### 7. Y2K 风格

dist-ledger 与 lifeline index.html 均 #F0F8FF/#B8E0F7 冰蓝 + 磨砂玻璃 backdrop-filter + 24px 圆角；无外部 decoration 引用无 404；图标 assets/icon-192/512.png 存在；manifest id/名称正确（lifeline / ledger「Life Ledger」）。✓

---

## 四、D 类 · 去重 / 命中率 / 硬编码专项（只读审计）

### D-1 功能重叠（AI 命中率风险，按严重度排序，给出建议未改）

| # | 重叠对 | 严重度 | 建议 |
|---|---|---|---|
| D1 | 华为「查看通知」vs「读取微信消息」（底层同一 getNotifications，后者仅网页端 filter 微信） | 中 | 二选一：①「查看通知」加 filter 参数，删「读取微信消息」；②保留则描述切死——「查看通知」写「全部 App 通知，含微信」，「读取微信消息」写「仅微信聊天消息，已过滤其他 App，不是历史聊天记录」 |
| D2 | 华为「实时天气」vs 内置 REST「天气查询」（builtin_weather 默认关闭需 Key） | 中 | 华为启用时把 builtin_weather 一并置灰/提示；描述强化分工（天气查询=需指定城市名；实时天气=GPS 自动定位免 Key） |
| D3 | 「查看手机状态」vs 现实桥「查看全部手机数据」 | 低（已缓解） | 华为启用时注入层整条剔除现实桥，模型不会同时拿到，保持现状 |
| D4 | 「读取微信消息」vs 内置工作流「查{{user}}手机」(读取微信会话/联系人) | 低 | 「读取微信消息」描述补「读的是最近通知，不是历史聊天记录；要翻历史聊天用查手机工作流」 |
| D5 | 「发送提醒」vs 日历「添加日程」 | 低 | 「发送提醒」描述补「立刻在手机弹一条通知，不写入日历；要排期用日历管理」 |
| D6 | REST/组合工具可任意命名，无跨命名空间撞名校验（内置工具优先，同名被静默遮蔽） | 低 | 「添加 REST/组合工具」时校验名称不得与内置子工具重名 |

工作流重复：builtin-phone-workflows.ts 唯一内置组合包与其它列表无重复。

### D-2 工具描述质量改进点（仅建议，未改）

Q1 描述/参数示例字面写死 com.tencent.mm 等包名（types.ts 已有常量）→ 描述用自然语言「微信/支付宝」，包名只留参数示例一处；Q2/Q3 专注/息屏描述夹参数名 durationMin/seconds → 改为「N 分钟/N 秒」；Q4 「查看记账」未说明副作用（调用会先 sync 拉通知落账）→ 描述补「调用时会顺带把最近支付通知去重落账」；Q6 查看手机状态 description 写「音量」可写「媒体音量」。

### D-3 交叉核对

15 工具名在「定义→识别→执行 case→桥方法」四处完全闭合（表格见各代理报告，本清单二节已引）；getEnabledInternalCapabilities 互斥逻辑存在且只作用于注入层；types.ts 曾声明 8 个 Kotlin 未实现方法（并行代理已陆续在 Kotlin 补齐，剩闭环由代理完成）。

---

## 五、硬编码死数据专项结论（用户硬性检查项）

判断标准：业务常量/数据契约/构建期注入=可接受；本该可配却写死、或双侧不一致=需修。

### 需修 / 需关注（3 项）

| # | 位置 | 硬编码内容 | 判断 | 改法 |
|---|---|---|---|---|
| H1 | types.ts:53-54 + RealityBridgeNotificationListener.kt PAY_PACKAGES | **支付来源包名双侧各写一份且不一致**：网页只认 com.tencent.mm(微信)/com.eg.android.AlipayGphone(支付宝)；Kotlin 收 6 个（微信/支付宝/云闪付/淘宝/京东/PayPal）。后果：云闪付/淘宝/京东/PayPal 被 Kotlin 解析上报，但网页 paymentToLedgerRecord 一律归 source:"manual"，PAYMENT_SOURCE_OPTIONS 只有 全部/微信/支付宝，这些钱进「其他」无法按来源筛 | **需修** | 「设置→华为壳」加「记账来源 App 包名」多选列表（默认 [微信,支付宝]），types.ts 导出该清单并下发壳，Kotlin 只收列表内包名，PaymentSource 与分账 label 跟随同一份配置，消除双写。注：微信/支付宝分账本身工作正常，此为渠道扩展与一致性改进 |
| H2 | tool-executor.ts:1139 等 | 魔法数 Math.max(limit,30)、测试用 30/10 | 需关注（轻） | 提为命名常量 LEDGER_SYNC_MIN_LIMIT |
| H3 | MainActivity.kt VERSION="1.0.0" vs build.gradle versionName | 版本号双写 | 需关注（轻） | 壳侧改读 BuildConfig.VERSION_NAME |

### 可接受（业务常量/契约/可配默认，逐项确认）

- 天气 URL（open-meteo 默认）→ 设置页可改模板 {lat}{lng}{key}，已可配 ✓
- weatherApiKey → 设置页输入框，默认空 ✓
- 专注 25 分/息屏 60 秒/通知 10 条/记账 20 条/来源 all → 设置页均可改 ✓
- 存储键 settings v1 / ledger v1、账本契约 appId=ledger/collection/records → 数据契约，与 ledger 应用核对一致 ✓
- 账本上限 5000、请求超时 4s/8s → 性能常量，不暴露 ✓
- huaweiAppLabel 22 个包名→中文名字典 → 纯展示字典，未知包名回退原名 ✓
- HUAWEI_PRESS_KEY_LABELS → 业务常量 ✓
- SITE_URL → GitHub Actions 环境变量注入（SHELL_SITE_URL），生产 URL 不进代码库 ✓
- Kotlin UI/行为常量（悬浮球 46dp、双击 300ms、门禁冷却 1500ms、手势 60/500/300ms、JPEG 80、通知 id 起点 200、缓存 200 条）→ 业务常量 ✓
- builtin_weather/builtin_search 的 Key → 内置模板，Key 由用户在设置填，未硬编码密钥 ✓
- lifeline/ledger 的 Supabase publishable URL+anon key 三处重复 → anon key 设计上公开，可接受；建议后续抽常量（记录）✓

### 专项确认（用户点名项）

具体城市/位置坐标：**无**（天气/位置全走 getLocation 实时定位，设置页明写「不写死城市」）；token/密钥/API key：**无**；天气来源：open-meteo 但为可配置默认值；目标 app 包名：业务常量或参数示例文本；时间阈值：可配默认或性能常量。

---

## 六、npm run build 验证

- 环境注意：机器上有常驻 local-next-server.mjs --dev 与 build 共用 .next 目录，并发时会报 pages-manifest.json ENOENT（非代码问题）。验证时先停 dev server → npm run build → 重启 dev server。
- 结果：weixin-assistant-dist ✓ / personal-push-dist ✓ / next build ✓（编译成功 + 71 静态页生成 + 路由表完整）/ restore-backdrop-filter ✓（+152 条 backdrop-filter），退出码 0。
- 该 build 覆盖全部现行网页代码（并行代理最后写文件 4:20，build 4:24-4:28）。

---

## 七、未闭环与后续项（诚实声明）

1. **并行代理 5 新能力执行分支未接完**：7 个静态新工具（查看设备详情/调节音量/调节亮度/读取剪贴板/写入剪贴板/打开网页/读取文件）已在 SUBTOOLS+usage guide+types.ts+Kotlin ShellBridge 落地，但 isHuaweiShellToolName 静态名单/独立 switch case 未补（default 只匹配自定义动作）——由并行代理收尾，本轮未接（避免冲突）。build 通过，当前半成品不阻塞。
2. **Android 14+ mediaProjection 前台服务**：targetSdk 34 在 Android 14+ 设备上 getMediaProjection 仍要求 foregroundServiceType="mediaProjection" 的 FGS 在跑，否则 SecurityException。华为 P60/HarmonyOS 多为 API 31-33 不触发，但新设备会崩。后续建议新增 RealityBridgeMediaProjectionService（manifest 声明 mediaProjection 类型 + 已加权限），capture 前 startForegroundService 再 getMediaProjection。另建议 FloatingService 的 specialUse 补 PROPERTY_SPECIAL_USE_FGS_SUBTYPE 元数据（合规提示）。
3. **读取文件工具的分区存储限制**：manifest 未声明任何存储权限，targetSdk 34 下 readFile 对公共目录（Downloads 等）直接 java.io.File 读取会被 Scoped Storage 拒（Permission denied）。补齐需：声明 READ_MEDIA_IMAGES/VIDEO/AUDIO（33+）+ READ_EXTERNAL_STORAGE maxSdkVersion=32（26-32），并加运行时请求链路；或改用 SAF ACTION_OPEN_DOCUMENT 选择器复用 fileChooserLauncher（需新增回传通道）。属于 5 新能力收尾的一部分。
4. **悬浮球截图在壳退到后台时的限制**：deliverToWeb 依赖 activeActivity 存活，App 完全退到后台时截图无法送达网页（设计取舍，可后续用通知+FGS 方案改进）。
5. mobile-enhance.js 中文乱码（历史遗留）与快速面板旧账本入口（R2）：建议后续处理，未在本轮动（避免动 lifeline 老功能）。

---

## 八、本轮实际修改文件汇总

| 文件 | 改动 |
|---|---|
| android-shell\...\MainActivity.kt | errJson() 新增；线程修复 5 处 + 并行代理 8 方法内 2 处；错误 JSON 转义 21 处；companion 新增 requestScreenCaptureForFloatingBall |
| android-shell\...\MediaProjectionCapture.kt | 删除 bitmap.recycle()；token 复用/needsReauth/busy/onStop 清理 重写 |
| android-shell\...\RealityBridgeAccessibility.kt | focusMode clamp 240、screenBreak clamp 3600 |
| android-shell\...\RealityBridgeFloatingService.kt | 双击回调接重授权路径 |
| android-shell\...\AndroidManifest.xml | 新增 FOREGROUND_SERVICE_MEDIA_PROJECTION 权限 |
| components\chat\mascot-chat-room.tsx | 新增 window.__floatBridgeOnScreenShot 接收端（截图挂发送框待发送，上限 4 张） |
| components\huawei-shell-settings.tsx | 删除重复 import loadHuaweiShellSettings（编译级修复） |
| packages\lifeline\build\dist-ledger\ledger-storage.js | getPayments 解包 {ok,payments} + 传 {limit} 对象 |
| packages\lifeline\mobile-enhance.js | 2 处 CSS content 闭引号修复 |
| packages\lifeline\build\dist-lifeline\mobile-enhance.js | 同步修复版（哈希一致 + node --check 通过） |

未改动（复查无问题或属并行代理在写）：RealityBridgeNotificationListener.kt、accessibility_service_config.xml、strings.xml、build.gradle、lib\internal-capability-storage.ts、lib\tool-executor.ts、lib\huawei-shell\*（15 工具无功能 bug；并行代理半成品未动）、custom-app-runner.tsx、custom-app-host-api.ts（复查通过）。
