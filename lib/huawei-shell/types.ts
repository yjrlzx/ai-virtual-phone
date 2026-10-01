/** 华为壳：网页侧 window.AndroidShell 原生桥的类型声明。
 *  与 android-shell 的 MainActivity.kt ShellBridge 一一对应，只做网页侧类型，
 *  不改动任何 Kotlin 代码。方法签名以 ShellBridge 实际暴露为准。 */

export type HuaweiShellBridge = {
    getVersion?(): string;
    openAppSettings?(): void;
    requestIgnoreBatteryOptimization?(): void;

    accessibilityActive?(): boolean;
    dumpScreen?(): string;
    clickText?(text: string): string;
    inputText?(text: string): string;
    captureScreen?(): void;

    openApp?(packageName: string): string;
    getStatus?(): string;
    /** 系统状态快照（Operit 式）：{ok,batteryLevel,isCharging,networkType,location?:{lat,lng},foregroundApp?} */
    getSystemContextSnapshot?(): string;
    setFloating?(enabled: boolean): void;
    setLockedPackages?(json: string): string;
    getLockedPackages?(): string;
    longPress?(x: number, y: number): string;
    swipe?(x1: number, y1: number, x2: number, y2: number): string;
    pressKey?(key: string): string;

    getNotifications?(limit: number): string;
    getPayments?(limit: number): string;
    getCurrentApp?(): string;
    getLocation?(): string;

    focusMode?(durationMin: number): string;
    screenBreak?(seconds: number): string;
    isFocusing?(): boolean;
    sendNotification?(title: string, content: string, openApp?: string): string;

    getDeviceInfo?(): string;
    setVolume?(stream: string, value: number): string;
    setBrightness?(value: number): string;
    readClipboard?(): string;
    writeClipboard?(text: string): string;
    openUrl?(url: string): string;
    runShellCommand?(command: string): string;
    readFile?(path: string): string;
    startListening?(configJson: string): string;
    stopListening?(): string;
    ring?(timeoutSec: number): string;
    stopRing?(): string;
    startWakeWord?(configJson: string): string;
    stopWakeWord?(): string;
    enrollWakeWord?(): string;
    /** 语音合成朗读。configJson: {text, queue?, rate?, pitch?, languageTag?}；事件异步回传 window.__floatBridgeOnTtsEvent */
    speak?(configJson: string): string;
    /** 停止当前朗读并清空朗读队列 */
    stopSpeak?(): string;
    /** 查询朗读状态 → {ok, speaking, queueLength, engine} */
    ttsStatus?(): string;
    /** 列出端上已录制唤醒词模板数 → {ok, count} */
    listWakeTemplates?(): string;
    /** 清空端上已录制唤醒词模板 → {ok, cleared} */
    clearWakeTemplates?(): string;
    ocrPaymentsCapture?(configJson: string): string;
    readGadgetbridgeHealth?(exportPath: string): string;
    getPermissionStatus?(customSuCommand?: string): string;
    openPermissionSettings?(setting: string): string;
    /** 系统控制权限实时状态 → {ok, writeSettings, shizuku, bluetoothConnect} */
    getSystemControlStatus?(): string;
    /** 弹系统授权框请求 BLUETOOTH_CONNECT（API31+）→ {ok, message} */
    requestBluetoothPermission?(): string;
    /** 弹系统授权框请求定位运行时权限 → {ok, message} */
    requestLocationPermission?(): string;

    /** Shizuku 执行 shell，返回 {ok, stdout, stderr, exitCode}（照搬 Operit 系统操作核心） */
    executeShellCommand?(command: string): string;
    /** 弹窗请求 Shizuku 授权，返回 {ok, message} */
    requestShizukuPermission?(): string;
    /** 列出已安装应用，返回 {ok, count, apps:[{pkg,label,isSystem,isEnabled}]} */
    getInstalledApps?(): string;
    /** 安装壳内置的 Shizuku APK，返回 {ok, message} */
    installBundledShizuku?(): string;
    /** 管理应用：action ∈ force_stop / enable / disable / uninstall，返回 {ok, message} */
    manageApp?(action: string, packageName: string): string;
    /** 开关飞行模式（需 Shizuku / 写设置），返回 {ok, message} */
    setAirplaneMode?(on: boolean): string;
    /** 拉起安卓悬浮小窗里的速聊 WebView（/chat-float） */
    openFloatingChat?(): void;

    // ── 补全 Operit 能力：点按 / Toast / 媒体键 / 蓝牙 / 文件 / 设置读写 / 用量 / 文件分享 ──
    /** 无障碍点按（归一化 0..1000 坐标）→ {ok} */
    tap?(x: number, y: number): string;
    /** 弹短 Toast → {ok} */
    toast?(text: string): string;
    /** 媒体键：action ∈ play_pause / next / previous / stop → {ok, action, code, viaShizuku} */
    musicControl?(action: string): string;
    /** 蓝牙状态 → {ok, available, enabled} */
    getBluetoothState?(): string;
    /** 开关蓝牙 → {ok, on, enabled} */
    setBluetoothEnabled?(on: boolean): string;
    /** 列已配对蓝牙设备 → {ok, devices:[{name,address}]}（API31+ 需 BLUETOOTH_CONNECT） */
    listBondedDevices?(): string;
    /** 写 UTF-8 文本文件（自动建父目录）→ {ok, path, bytes} */
    writeFile?(path: string, content: string): string;
    /** 删除文件或目录（目录递归删除）→ {ok, path} */
    deleteFile?(path: string): string;
    /** 建目录（含父目录）→ {ok, path} */
    makeDirectory?(path: string): string;
    /** 递归查找文件（最多 3 层、100 条）→ {ok, matches:[{path,size,isDir}], count} */
    findFiles?(rootPath: string, query: string): string;
    /** 读系统设置：namespace ∈ system / secure / global → {ok, namespace, key, value} */
    getSystemSetting?(namespace: string, key: string): string;
    /** 写系统设置：namespace ∈ system / secure / global（写 system 需 WRITE_SETTINGS）→ {ok, namespace, key, value} */
    setSystemSetting?(namespace: string, key: string, value: string): string;
    /** 今日应用使用时长 TOP20 → {ok, usages:[{pkg,totalTimeMs}]}（需用量访问权限） */
    getAppUsageTime?(): string;
    /** 用系统查看器打开文件（FileProvider 临时授权）→ {ok, path, mime} */
    openFile?(path: string): string;
    /** 经系统分享面板发送文件（FileProvider 临时授权）→ {ok} */
    shareFile?(path: string, mime: string): string;
};

/** 桥返回的统一 JSON 外壳：{ok:boolean, ...}，失败时带 error 字段 */
export type ShellJsonResult = {
    ok: boolean;
    error?: string;
    [key: string]: unknown;
};

/** 门禁锁 App 的包名常量（自动记账与锁 App 列表共用） */
export const WECHAT_PACKAGE = "com.tencent.mm";
export const ALIPAY_PACKAGE = "com.eg.android.AlipayGphone";

/** 自动记账来源筛选 */
export type PaymentSource = "all" | "wechat" | "alipay";

/** 来源 pkg → 显示名（未知包名保留原名） */
export function paymentSourceLabel(pkg: string): string {
    if (pkg === WECHAT_PACKAGE) return "微信";
    if (pkg === ALIPAY_PACKAGE) return "支付宝";
    return pkg || "未知";
}
/** 自定义快捷动作：用户在 设置 → 华为壳 登记后，自动生成一个 char 可直接调用的网页工具。 */
export type HuaweiCustomActionType = "open_app" | "send_notification" | "read_status" | "shell";

/** 读取内置状态的可选键（read_status 动作） */
export type HuaweiStatusKey =
    | "battery" | "volume" | "network" | "accessibility" | "floating" | "locked"
    | "location" | "current_app";

export type HuaweiCustomAction = {
    id: string;
    /** char 调用名（工具名，需与内置工具不重名） */
    name: string;
    type: HuaweiCustomActionType;
    /** 告诉角色何时使用 */
    description: string;
    /** open_app：应用包名（默认值；char 调用时可覆盖，支持 {参数名} 占位） */
    packageName?: string;
    /** send_notification：标题 / 内容 / 点击后打开的应用包名（支持 {参数名} 占位） */
    title?: string;
    content?: string;
    openApp?: string;
    /** read_status：读取哪个内置状态 */
    statusKey?: HuaweiStatusKey;
    /** shell：要执行的命令（支持 {参数名} 占位） */
    command?: string;
    /** 调用动作时需要传入的运行参数（命令/标题/正文里用 {key} 占位） */
    params?: HuaweiActionParam[];
    /** 执行完是否把结果回传：none=发完即走，text=把结果摘要送达 */
    resultMode?: HuaweiActionResultMode;
    /** 结果摘要的送达方式：notification=系统通知栏，clipboard=写入剪贴板 */
    deliveryMode?: HuaweiActionDelivery;
    enabled: boolean;
    createdAt: number;
};

/** 自定义动作的运行参数：调用时收集值，填进命令/标题/正文里的 {key} 占位 */
export type HuaweiActionParam = {
    key: string;
    type: "string" | "number";
    description: string;
};

/** 动作执行结果回传模式 */
export type HuaweiActionResultMode = "none" | "text";

/** 动作结果摘要的送达方式 */
export type HuaweiActionDelivery = "notification" | "clipboard";

/** 现实桥事件日志：规则命中 / 动作执行 / 主动查询 的逐条记录，历史记录 Tab 展示 */
export type HuaweiBridgeEvent = {
    id: string;
    ts: number;
    kind: "rule" | "action" | "query";
    title: string;
    detail?: string;
    ok: boolean;
};

/** 自动联动规则触发方式 */
export type HuaweiTriggerRuleTrigger = "notification" | "time";
/** 联动规则执行的动作 */
export type HuaweiTriggerRuleAction = "send_notification" | "open_app" | "custom_action";

export type HuaweiTriggerRule = {
    id: string;
    /** 规则名（设置页展示） */
    name: string;
    enabled: boolean;
    trigger: HuaweiTriggerRuleTrigger;
    /** notification 触发：来源包名；"payment" = 微信/支付宝支付通知；空 = 任意来源 */
    notifyPkg?: string;
    /** notification 触发：通知文本包含的关键词（可空） */
    notifyKeyword?: string;
    /** time 触发：HH:MM，例如 "08:00" */
    time?: string;
    /** time 触发：星期数组（"sun".."sat"）；空 = 每天 */
    days?: string[];
    /** 触发后执行的动作 */
    action: HuaweiTriggerRuleAction;
    /** send_notification 动作参数 */
    title?: string;
    content?: string;
    openApp?: string;
    /** open_app 动作参数：应用包名 */
    actionPackageName?: string;
    /** custom_action 动作参数：用户登记的自定义动作名 */
    actionName?: string;
    /** 通知命中后的内容加工方式：raw=按固定文案发送，template=把命中通知文本填进 {payload} 占位 */
    processMode?: "raw" | "template";
    /** template 模式下发送的正文模板，{payload}/{title}/{text} 会被替换成命中通知内容 */
    contentTemplate?: string;
    /** 上次触发时间（防抖） */
    lastTriggeredAt?: number;
    /** 通知类规则：已处理的最大通知时间戳 */
    lastSeenTs?: number;
    /** 累计触发次数 */
    triggerCount?: number;
};

/** 语音转文字模式：system=系统识别 / online=在线接口 / cloud=float 云端转写 */
export type HuaweiSttMode = "system" | "online" | "cloud";
/** 唤醒词检测模式：system=系统识别文本匹配 / on_device=端上模板（VAD+MFCC+DTW） */
export type HuaweiWakeWordMode = "system" | "on_device";
/** 唤醒后动作：floating=打开速聊浮窗 / chat=进入对话 */
export type HuaweiWakeWordAction = "floating" | "chat";
/** OCR 记账识别后端：mlkit=本机 / online=在线接口 / web=回传网页视觉 */
export type HuaweiOcrEngine = "mlkit" | "online" | "web";
/** 穿戴健康数据源：gadgetbridge_sqlite=原生读导出库 / json=外部 JSON 快照 / off */
export type HuaweiHealthSource = "gadgetbridge_sqlite" | "json" | "off";
/** 行踪隐私模式：semantic=对外语义化 / diagnostic=含坐标 / off=不记录 */
export type HuaweiWhereaboutsPrivacy = "semantic" | "diagnostic" | "off";
/** 常用地点（geofence 圆心与半径，米） */
export type HuaweiPlace = {
    name: string;
    lat: number;
    lng: number;
    radiusM: number;
};
/** 足迹条目（语义化对外，坐标仅在 diagnostic 模式保留） */
export type HuaweiFootprintEntry = {
    ts: number;
    semantic: string;
    status: "home" | "place" | "away" | "moving";
    placeName?: string;
    lat?: number;
    lng?: number;
};
/** 穿戴健康快照（Gadgetbridge 导出库 / JSON 快照） */
export type HuaweiHealthSnapshot = {
    status: string;
    stepsToday: number | null;
    latestHeartRate: number | null;
    latestHeartRateAt: number | null;
    latestStress: number | null;
    activeCaloriesToday: number | null;
    sleepMinutes: number | null;
    sleepStartedAt: number | null;
    sleepWakeAt: number | null;
    message: string;
    updatedAt: number;
};
/** 权限层级状态（照搬 Operit 五级体系 + 华为适配） */
export type HuaweiPermissionStatus = {
    standard: { location: boolean; microphone: boolean; storage: boolean };
    accessibility: boolean;
    notificationListener: boolean;
    debugger: {
        shell: boolean;
        file: boolean;
        shizukuInstalled: boolean;
        shizukuRunning: boolean;
        shizukuPermission: boolean;
    };
    admin: { mediaProjection: boolean; overlay: boolean; writeSettings: boolean; batteryOptimization: boolean };
    root: { available: boolean; granted: boolean; hint: string };
};

/** getInstalledApps 返回的单个应用条目 */
export type HuaweiInstalledApp = {
    pkg: string;
    label: string;
    isSystem: boolean;
    isEnabled: boolean;
};