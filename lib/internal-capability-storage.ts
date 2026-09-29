import type { InternalCapabilityConfig } from "./settings-types";
import { isAgentComputerConfigured, isContainerComputer } from "./agent-computer";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadBridgeDataItems, loadBridgeShortcutActions, parseBridgeActionParameterSchema } from "./reality-bridge/storage";
import { loadHuaweiCustomActions } from "./huawei-shell/storage";
import type { HuaweiCustomAction } from "./huawei-shell/types";
import { WRITE_REAL_CALENDAR_TOOL_DEFINITION } from "./char-tools-automation";

const INTERNAL_CAPABILITIES_KEY = "ai_phone_internal_capabilities_v1";
registerKvMigration(INTERNAL_CAPABILITIES_KEY);

export const MEMORY_WRITE_CAPABILITY_ID = "memory_write";
export const NOTE_WALL_CAPABILITY_ID = "note_wall_service";
export const MUSIC_CONTROL_CAPABILITY_ID = "music_control";
export const CALENDAR_MANAGEMENT_CAPABILITY_ID = "calendar_management";
export const SEND_FILE_CAPABILITY_ID = "send_file";
export const AGENT_COMPUTER_CAPABILITY_ID = "agent_computer";
export const LOCAL_DATA_LIBRARY_CAPABILITY_ID = "local_data_library";
export const TOOLBOX_MANAGEMENT_CAPABILITY_ID = "toolbox_management";
export const TIMED_WAKE_CAPABILITY_ID = "timed_wake";
export const REALITY_BRIDGE_CAPABILITY_ID = "reality_bridge_send";
export const HUAWEI_SHELL_CAPABILITY_ID = "huawei_shell_control";
export const LIFELINE_CAPABILITY_ID = "lifeline";

export type InternalToolDefinition = {
    name: string;
    description: string;
    parameterSchema: string;
    usageGuide?: string;
};

const MEMORY_WRITE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        content: {
            type: "string",
            description: "要写入的事实性长期记忆，用简洁中文描述",
        },
        importance: {
            type: "number",
            description: "重要性，0 到 1 之间，仅在确实重要时使用较高分值",
        },
        reason: {
            type: "string",
            description: "简短说明为什么这条信息值得长期记住",
        },
    },
    required: ["content"],
});

const MEMORY_WRITE_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "动作：写入记忆",
    "用途：把明确、稳定、长期有效的信息写入角色的长期记忆。",
    "",
    "允许写入：",
    "- 用户明确提供的长期身份信息、固定偏好、习惯",
    "- 双方做出的明确约定或承诺",
    "- 关系中的明确里程碑",
    "- 对后续互动长期有帮助的稳定事实",
    "",
    "禁止写入：",
    "- 一次性寒暄",
    "- 普通情绪波动",
    "- 暂时性矛盾",
    "- 猜测、脑补、推断",
    "- 没有长期价值的随口内容",
    "",
    "参数：",
    "- content (string): 要写入的事实性记忆，用简洁中文描述",
    "- importance (number): 0 到 1，仅高价值信息使用较高分值",
    "- reason (string): 简短说明为什么值得记住",
    "",
    "content 写法要求：",
    "- 用事实句，不要写“我觉得”“可能”“似乎”",
    "- 尽量一条记忆只写一件事",
    "- 不要写成长段总结",
    "- 不要带格式标记",
    "",
    "正确示例：",
    `[执行动作:写入记忆({"content":"用户的生日是5月18日。","importance":0.9,"reason":"这是稳定且长期可复用的个人信息"})]`,
    "",
    "错误示例：",
    "- 她今天有点不开心",
    "- 她应该很喜欢我",
    "- 这次聊天气氛不错",
    "",
    "如果确定需要写入，请直接输出执行动作指令，不要附加其他内容。",
].join("\n");

const TIMED_WAKE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        delayMinutes: {
            type: "number",
            description: "从现在开始多少分钟后到点（到点你会被带回来主动联系），必须是正数",
        },
        intent: {
            type: "string",
            description: "到点后你想主动做什么或想找对方聊什么，用一句话写清楚",
        },
    },
    required: ["delayMinutes", "intent"],
});

const TIMED_WAKE_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "动作：稍后主动联系",
    "用途：为当前聊天约定「过一会儿主动联系对方」。这不是睡觉醒来——而是你现在决定隔一段时间再主动找对方；到点后系统会把你当时的想法推回上下文，你再决定发消息还是先不发。",
    "",
    "参数：",
    "- delayMinutes (number): 从现在开始多少分钟后到点，必须大于 0",
    "- intent (string): 到点后你想主动做什么 / 想找对方聊什么，用一句话说明",
    "",
    "规则：",
    "- 只在你确实打算稍后主动找对方时使用。",
    "- 同一聊天同时只保留一个约定；新的设置会替换旧的。",
    "- 到点后不要机械发送，结合上下文判断该不该开口；不合适就静默。",
    "",
    "示例：",
    '[执行动作:稍后主动联系({"delayMinutes":15,"intent":"过15分钟看看对方回了没，如果还合适就轻轻找一句"})]',
].join("\n");

const NOTE_WALL_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：便签墙",
    "用途：公共社区便签墙相关服务。",
    "",
    "执行时必须使用下面的具体动作名，不要输出“便签墙”本身。",
    "",
    "活人感要求：",
    "- 发送便签时像顺手贴下的生活碎片：口语、具体、去精致，可吐槽、疑问、玩笑、碎碎念；不要作文腔、总结腔、AI味。",
    "- 发送便签评论时短一点，接住便签里的具体点自然回应；可以调侃、追问、附和、轻怼，别客服腔、别一味夸。",
    "- 禁止讲大道理、爹味说教、强行升华；禁止“引用原文+这句太真实了”这类套话。",
    "",
    "动作：查看便签列表",
    "描述：查看公共便签墙上的便签列表。",
    "参数：",
    "  - limit (number): 返回数量，1-30，默认 20",
    "  - sort (string): 排序方式，latest=最新，hot=互动最多，all=全部，默认 latest",
    "示例：",
    '[执行动作:查看便签列表({"limit":20,"sort":"latest"})]',
    "",
    "动作：查看便签详情及评论",
    "描述：查看某张便签的完整正文和评论。",
    "参数：",
    "  - noteId (string): 便签列表或上下文中提供的 noteId",
    "  - commentLimit (number): 返回评论数量，1-30，默认 20",
    "示例：",
    '[执行动作:查看便签详情及评论({"noteId":"便签noteId","commentLimit":20})]',
    "",
    "动作：发送便签",
    "描述：以当前角色身份在公共便签墙上发送一张便签。",
    "参数：",
    "  - authorName (string): 右下角落款名，由你自己决定",
    "  - summary (string): 便签标题；便签卡片上方加粗显示的短标题，建议 4-18 字，不要复述 body 的第一句",
    "  - body (string): 点开后的完整正文；口语、具体、有生活细节；不要重复 summary，也不要以 summary 原文开头再扩写，可用 \\n 分成 2-4 段",
    "  - size (string): small|medium|large，默认 medium",
    "  - paper (string): plain|cream|pink|blue|kraft，默认 plain",
    "  - tape (string): none(透明胶)|masking|stripe|flower，默认 none",
    "  - font (string): default|huangyou|shangshangqian|huiwen，默认 default",
    "  - isAnonymous (boolean): 是否匿名。即使匿名，也要填写 authorName，前台会显示匿名",
    "示例：",
    '[执行动作:发送便签({"authorName":"落款名","summary":"逃课念头","body":"今天只想把书包留在门口，假装铃声没有响过。\\n如果有人问我去哪了，就说我去晒太阳了。","paper":"cream","tape":"masking","font":"huiwen","isAnonymous":false})]',
    "",
    "动作：发送便签评论",
    "描述：以当前角色身份回复某张便签。",
    "参数：",
    "  - noteId (string): 要回复的便签 noteId",
    "  - authorName (string): 评论显示的落款名，由你自己决定",
    "  - body (string): 评论内容，20-160字更自然；短、口语、接住具体点，别客服腔或总结腔",
    "  - isAnonymous (boolean): 是否匿名。即使匿名，也要填写 authorName",
    "示例：",
    '[执行动作:发送便签评论({"noteId":"便签noteId","authorName":"落款名","body":"看到这里时突然很想接一句：这张便签我会记得。","isAnonymous":false})]',
    "",
    "查看类动作会返回结果，你可以基于结果继续决定是否发送便签或便签评论。发送类动作会直接执行，执行时只输出执行动作指令，不要附加闲聊内容。",
].join("\n");

const MUSIC_CONTROL_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：网易云音乐",
    "用途：控制{{user}}小手机里的音乐播放，查看{{user}}小手机里的音乐库、网易云歌单和播放列表。",
    "",
    "执行时必须使用下面的具体动作名，不要输出“网易云音乐”本身。",
    "",
    "【优先规则·重要】",
    "- 想放某首歌 → 直接一步调「播放音乐」(传 query 即可)，禁止先调「查看音乐状态/音乐库概览/歌单歌曲」等查看动作来'勘察'。「播放音乐」自带搜索，无需任何前置查看。",
    "- 「查看××」这几个动作只在{{user}}明确问起时才用：问'我有哪些歌/歌单'→查看音乐库概览；问'现在放的是什么'→查看音乐状态。平时放歌一律不用。",
    "- 想直接放给{{user}}听 → 用「播放音乐」工具（真的会在 ta 手机上响起）；只有想'安利/推荐一首歌但不打断当前播放'时，才用 [音乐分享:歌名] 发卡片。{{user}}让你放歌时，默认用工具直接播放，不要只发分享卡片。",
    "",
    "动作：播放音乐",
    "描述：按歌曲 ID 或关键词播放音乐。没有 ID 时用 query 搜索最佳可播放结果。",
    "参数：",
    "  - query (string): 歌曲关键词",
    "  - source (string): local 或 netease；按 ID 播放时填写",
    "  - songId (string|number): 本地歌曲 ID 或网易云歌曲 ID",
    "示例：",
    '[执行动作:播放音乐({"query":"晴天"})]',
    "",
    "动作：搜索音乐",
    "描述：搜索本地音乐和网易云音乐。",
    "参数：",
    "  - query (string): 搜索关键词，可以是歌名、歌手或歌名+歌手",
    "  - limit (number): 返回数量，1-20，默认 10",
    "示例：",
    '[执行动作:搜索音乐({"query":"晴天","limit":10})]',
    "",
    "动作：查看音乐状态",
    "描述：查看当前播放歌曲、播放状态、播放模式和当前播放列表。",
    "参数：无",
    "示例：",
    "[执行动作:查看音乐状态({})]",
    "",
    "动作：查看音乐库概览",
    "描述：查看本地音乐、网易云登录状态、网易云歌单和近期播放概览。",
    "参数：",
    "  - playlistLimit (number): 返回歌单数量，1-30，默认 12",
    "  - localLimit (number): 返回本地歌曲数量，1-50，默认 20",
    "示例：",
    '[执行动作:查看音乐库概览({"playlistLimit":12,"localLimit":20})]',
    "",
    "动作：查看歌单歌曲",
    "描述：查看某个网易云歌单里的歌曲。先用“查看音乐库概览”拿到 playlistId。",
    "参数：",
    "  - playlistId (number|string): 网易云歌单 ID",
    "  - offset (number): 从第几首开始，默认 0",
    "  - limit (number): 返回数量，1-50，默认 30",
    "示例：",
    '[执行动作:查看歌单歌曲({"playlistId":123456,"limit":30})]',
    "",
    "动作：加入播放列表",
    "描述：把搜索结果、指定歌曲或一个歌单加入当前播放列表。",
    "参数：",
    "  - query (string): 搜索关键词",
    "  - source (string): local 或 netease；按 ID 添加时填写",
    "  - songId (string|number): 本地歌曲 ID 或网易云歌曲 ID",
    "  - playlistId (number|string): 网易云歌单 ID；填写后加入该歌单歌曲",
    "  - limit (number): 从搜索或歌单加入多少首，1-50，默认 10",
    "  - replace (boolean): 是否替换当前播放列表，默认 false",
    "  - playFirst (boolean): 是否立即播放加入的第一首，默认 false",
    "示例：",
    '[执行动作:加入播放列表({"playlistId":123456,"limit":20,"replace":true,"playFirst":true})]',
    "",
    "动作：切换音乐",
    "描述：控制当前播放器。",
    "参数：",
    "  - action (string): next|prev|pause|resume|stop",
    "示例：",
    '[执行动作:切换音乐({"action":"next"})]',
    "",
    "查看类动作会返回结果，你可以基于结果继续选择音乐。播放和切换会直接执行，执行时只输出执行动作指令，不要附加闲聊内容。",
].join("\n");

const CALENDAR_MANAGEMENT_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：日历管理",
    "用途：查看、添加、修改、取消你本周或指定日期所在周的日程。",
    "",
    "执行时必须使用下面的具体动作名，不要输出“日历管理”本身。",
    "",
    "动作：查看日程",
    "描述：查看当前角色指定周的日程，返回 itemId，可用于修改或取消。",
    "参数：",
    "  - date (string): YYYY-MM-DD，可选；留空表示当前日期所在周",
    "示例：",
    '[执行动作:查看日程({"date":"2026-03-17"})]',
    "",
    "动作：添加日程",
    "描述：添加一条日程。",
    "参数：",
    "  - date (string): 日期，YYYY-MM-DD",
    "  - startTime (string): 开始时间，HH:MM，范围 08:00-23:00",
    "  - endTime (string): 结束时间，HH:MM，必须晚于开始时间",
    "  - location (string): 地点；不确定写“无”",
    "  - title (string): 事项",
    "示例：",
    '[执行动作:添加日程({"date":"2026-03-17","startTime":"14:00","endTime":"16:00","location":"咖啡店","title":"和小明喝咖啡"})]',
    "",
    "动作：修改日程",
    "描述：修改一条已存在日程。优先使用查看日程返回的 itemId；没有 itemId 时用 keyword 搜索。",
    "参数：",
    "  - itemId (string): 查看日程返回的日程 ID，可选",
    "  - keyword (string): 原事项关键词；没有 itemId 时必填",
    "  - date (string): 新日期，YYYY-MM-DD",
    "  - startTime (string): 新开始时间，HH:MM",
    "  - endTime (string): 新结束时间，HH:MM",
    "  - location (string): 新地点",
    "  - title (string): 新事项",
    "示例：",
    '[执行动作:修改日程({"keyword":"部门周会","date":"2026-03-18","startTime":"10:00","endTime":"12:00","location":"公司会议室","title":"部门周会改期"})]',
    "",
    "动作：取消日程",
    "描述：取消一条已存在日程。优先使用查看日程返回的 itemId；没有 itemId 时用 keyword 搜索。",
    "参数：",
    "  - itemId (string): 查看日程返回的日程 ID，可选",
    "  - keyword (string): 事项关键词；没有 itemId 时必填",
    "示例：",
    '[执行动作:取消日程({"keyword":"部门周会"})]',
    "",
    "注意：",
    "- 日期必须使用 YYYY-MM-DD，时间必须使用 24 小时制 HH:MM。",
    "- 日程时间只能在 08:00-23:00 之间。",
    "- 修改和取消前，如果不确定 itemId 或关键词是否足够明确，先执行“查看日程”。",
    "- 添加、修改、取消会直接执行。执行时只输出执行动作指令，不要附加闲聊内容。",
].join("\n");

const NOTE_WALL_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        limit: {
            type: "number",
            description: "返回数量，1-30，默认 20",
        },
        sort: {
            type: "string",
            description: "排序方式：latest=最新，hot=互动最多，all=全部，默认 latest",
        },
    },
});

const NOTE_WALL_DETAIL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        noteId: {
            type: "string",
            description: "便签列表或上下文中提供的 noteId",
        },
        commentLimit: {
            type: "number",
            description: "返回评论数量，1-30，默认 20",
        },
    },
    required: ["noteId"],
});

const NOTE_WALL_NOTE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        authorName: {
            type: "string",
            description: "右下角落款名，由你自己决定",
        },
        summary: {
            type: "string",
            description: "便签标题；便签卡片上方加粗显示的短标题，建议 4-18 字，不要复述 body 的第一句",
        },
        body: {
            type: "string",
            description: "点开后的完整正文；口语、具体、有生活细节；不要重复 summary，也不要以 summary 原文开头再扩写，可用 \\n 分成 2-4 段",
        },
        size: {
            type: "string",
            description: "small|medium|large，默认 medium",
        },
        paper: {
            type: "string",
            description: "plain|cream|pink|blue|kraft，默认 plain",
        },
        tape: {
            type: "string",
            description: "none(透明胶)|masking|stripe|flower，默认 none",
        },
        font: {
            type: "string",
            description: "default|huangyou|shangshangqian|huiwen，默认 default",
        },
        isAnonymous: {
            type: "boolean",
            description: "是否匿名。即使匿名，也要填写 authorName，前台会显示匿名",
        },
    },
    required: ["summary", "body"],
});

const NOTE_WALL_COMMENT_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        noteId: {
            type: "string",
            description: "要回复的便签 noteId",
        },
        authorName: {
            type: "string",
            description: "评论显示的落款名，由你自己决定",
        },
        body: {
            type: "string",
            description: "评论内容，20-160字更自然；短、口语、接住具体点，别客服腔或总结腔",
        },
        isAnonymous: {
            type: "boolean",
            description: "是否匿名。即使匿名，也要填写 authorName",
        },
    },
    required: ["noteId", "body"],
});

const MUSIC_EMPTY_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {},
});

const MUSIC_OVERVIEW_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        playlistLimit: { type: "number", description: "返回网易云歌单数量，1-30，默认 12" },
        localLimit: { type: "number", description: "返回本地歌曲数量，1-50，默认 20" },
    },
});

const MUSIC_PLAYLIST_TRACKS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        playlistId: { type: ["number", "string"], description: "网易云歌单 ID" },
        offset: { type: "number", description: "从第几首开始，默认 0" },
        limit: { type: "number", description: "返回数量，1-50，默认 30" },
    },
    required: ["playlistId"],
});

const MUSIC_SEARCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "搜索关键词，可以是歌名、歌手或歌名+歌手" },
        limit: { type: "number", description: "返回数量，1-20，默认 10" },
    },
    required: ["query"],
});

const MUSIC_PLAY_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "歌曲关键词" },
        source: { type: "string", description: "按 ID 播放时填写 local 或 netease" },
        songId: { type: ["number", "string"], description: "本地歌曲 ID 或网易云歌曲 ID" },
    },
});

const MUSIC_QUEUE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "搜索关键词" },
        source: { type: "string", description: "按 ID 添加时填写 local 或 netease" },
        songId: { type: ["number", "string"], description: "本地歌曲 ID 或网易云歌曲 ID" },
        playlistId: { type: ["number", "string"], description: "网易云歌单 ID；填写后加入该歌单歌曲" },
        limit: { type: "number", description: "从搜索或歌单加入多少首，1-50，默认 10" },
        replace: { type: "boolean", description: "是否替换当前播放列表，默认 false" },
        playFirst: { type: "boolean", description: "是否立即播放加入的第一首，默认 false" },
    },
});

const MUSIC_SWITCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        action: { type: "string", description: "next|prev|pause|resume|stop" },
    },
    required: ["action"],
});

const CALENDAR_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        date: { type: "string", description: "YYYY-MM-DD，可选；留空表示当前日期所在周" },
    },
});

const CALENDAR_ADD_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        date: { type: "string", description: "日期，YYYY-MM-DD" },
        startTime: { type: "string", description: "开始时间，HH:MM，范围 08:00-23:00" },
        endTime: { type: "string", description: "结束时间，HH:MM，必须晚于开始时间" },
        location: { type: "string", description: "地点；不确定写“无”" },
        title: { type: "string", description: "事项" },
    },
    required: ["date", "startTime", "endTime", "title"],
});

const CALENDAR_UPDATE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        itemId: { type: "string", description: "查看日程返回的日程 ID，可选" },
        keyword: { type: "string", description: "原事项关键词；没有 itemId 时必填" },
        date: { type: "string", description: "新日期，YYYY-MM-DD" },
        startTime: { type: "string", description: "新开始时间，HH:MM" },
        endTime: { type: "string", description: "新结束时间，HH:MM" },
        location: { type: "string", description: "新地点" },
        title: { type: "string", description: "新事项" },
    },
    required: ["date", "startTime", "endTime", "title"],
});

const CALENDAR_DELETE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        itemId: { type: "string", description: "查看日程返回的日程 ID，可选" },
        keyword: { type: "string", description: "事项关键词；没有 itemId 时必填" },
    },
});

const NOTE_WALL_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "查看便签列表",
        description: "查看公共便签墙上的便签列表。",
        parameterSchema: NOTE_WALL_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "查看便签详情及评论",
        description: "查看某张便签的完整正文和评论。",
        parameterSchema: NOTE_WALL_DETAIL_PARAMETER_SCHEMA,
    },
    {
        name: "发送便签",
        description: "以当前角色身份在公共便签墙上发送一张便签。",
        parameterSchema: NOTE_WALL_NOTE_PARAMETER_SCHEMA,
    },
    {
        name: "发送便签评论",
        description: "以当前角色身份回复某张便签。",
        parameterSchema: NOTE_WALL_COMMENT_PARAMETER_SCHEMA,
    },
];

const MUSIC_CONTROL_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "播放音乐",
        description: "按歌曲 ID 或关键词播放音乐。",
        parameterSchema: MUSIC_PLAY_PARAMETER_SCHEMA,
    },
    {
        name: "搜索音乐",
        description: "搜索本地音乐和网易云音乐。",
        parameterSchema: MUSIC_SEARCH_PARAMETER_SCHEMA,
    },
    {
        name: "查看音乐状态",
        description: "查看当前播放歌曲、播放状态、播放模式和当前播放列表。",
        parameterSchema: MUSIC_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查看音乐库概览",
        description: "查看本地音乐、网易云登录状态、网易云歌单和近期播放概览。",
        parameterSchema: MUSIC_OVERVIEW_PARAMETER_SCHEMA,
    },
    {
        name: "查看歌单歌曲",
        description: "查看某个网易云歌单里的歌曲。",
        parameterSchema: MUSIC_PLAYLIST_TRACKS_PARAMETER_SCHEMA,
    },
    {
        name: "加入播放列表",
        description: "把搜索结果、指定歌曲或一个歌单加入当前播放列表。",
        parameterSchema: MUSIC_QUEUE_PARAMETER_SCHEMA,
    },
    {
        name: "切换音乐",
        description: "控制当前播放器上一首、下一首、暂停、继续或停止。",
        parameterSchema: MUSIC_SWITCH_PARAMETER_SCHEMA,
    },
];

const CALENDAR_MANAGEMENT_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "查看日程",
        description: "查看当前角色指定周的日程。",
        parameterSchema: CALENDAR_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "添加日程",
        description: "添加一条日程。",
        parameterSchema: CALENDAR_ADD_PARAMETER_SCHEMA,
    },
    {
        name: "修改日程",
        description: "修改一条已存在日程。",
        parameterSchema: CALENDAR_UPDATE_PARAMETER_SCHEMA,
    },
    {
        name: "取消日程",
        description: "取消一条已存在日程。",
        parameterSchema: CALENDAR_DELETE_PARAMETER_SCHEMA,
    },
];

const AGENT_COMPUTER_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        op: { type: "string", enum: ["write", "read", "list", "send", "exec"], description: "操作：write 写文件 / read 读文件 / list 列目录 / send 把文件发给用户 / exec 执行 shell 命令" },
        path: { type: "string", description: "自己电脑里的文件或目录路径，如 /日记/八月.txt" },
        content: { type: "string", description: "写入的完整内容（op=write 必填）" },
        command: { type: "string", description: "要执行的 shell 命令（op=exec 必填）" },
    },
    required: ["op"],
});

function buildAgentComputerUsageGuide(): string {
    const execLine = isContainerComputer()
        ? "· op=exec：在终端里执行 shell 命令。你的电脑是真正的 Linux（bash 完整、可安装软件、可自由联网；文件在 /workspace 下持久保存）。删除类命令（rm）会真的删掉文件且无法恢复，动手前想清楚。"
        : "· op=exec：在终端里执行 shell 命令（ls/cat/grep/sed/awk/jq 等常用工具齐全，curl 可只读访问公开网页；不是完整 Linux，装不了软件）。删除类命令（rm）会真的删掉文件且无法恢复，动手前想清楚。";
    return [
        "这是你自己的电脑（云端、持久，只属于你这个角色）。你可以：",
        "· op=write：把想留存的东西写成文件（日记、写给对方的东西、随手记）。路径自己规划，如 /日记/2026-08-14.txt；",
        "· op=read / op=list：翻自己以前存的文件；",
        "· op=send：把电脑里的一个文件发给对方（会以文件消息出现在聊天里）；",
        execLine,
        "写什么、何时写由你自己决定，像真人使用电脑一样自然；不必每次聊天都用。",
    ].join("\n");
}

const SEND_FILE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        url: { type: "string", description: "文件的完整 URL 地址" },
        type: { type: "string", enum: ["audio", "image", "video", "file"], description: "文件类型" },
        title: { type: "string", description: "文件标题/描述（可选）" },
    },
    required: ["url", "type"],
});

const SEND_FILE_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：发送文件",
    "用途：将外部 URL 文件（音频、图片、视频、文件）发送给{{user}}，{{user}}可以直接播放或下载。",
    "",
    "使用场景：当你通过其他工具（如音乐生成 API、图片生成 API）获取到文件 URL 后，用此工具将文件发送给{{user}}。",
    "",
    "动作：发送文件",
    "参数：",
    "  - url (string, 必填): 文件的完整 URL",
    '  - type (string, 必填): 文件类型，可选 "audio"、"image"、"video"、"file"',
    "  - title (string, 可选): 文件标题或描述",
    "示例：",
    '[执行动作:发送文件({"url":"https://example.com/song.mp3","type":"audio","title":"为你写的歌"})]',
].join("\n");

const LOCAL_DATA_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "虚拟资料目录路径，默认 /。例如 /characters、/chat/indexeddb/AiPhoneChatDB" },
        limit: { type: "number", description: "返回数量上限，默认 30，最大 200" },
        offset: { type: "number", description: "分页偏移量，默认 0" },
    },
});

const LOCAL_DATA_READ_FILE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "要读取的虚拟文件或 IndexedDB store 路径" },
        limit: { type: "number", description: "读取数组或记录列表时的数量上限，默认 30，最大 200" },
        offset: { type: "number", description: "读取数组或记录列表时的分页偏移量，默认 0" },
        fields: { type: "array", items: { type: "string" }, description: "可选，只返回这些字段；支持点路径，例如 mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "fields 的别名" },
    },
    required: ["path"],
});

const LOCAL_DATA_FIELDS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "要查看字段的 KV/localStorage JSON 文件或 IndexedDB store 路径" },
        sample: { type: "number", description: "抽样记录数，默认 5，最大 50" },
    },
    required: ["path"],
});

const LOCAL_DATA_SEARCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "搜索范围路径，默认 /。可以是模块、资料源、KV 文件或 IndexedDB store" },
        query: { type: "string", description: "关键词；留空时返回该范围内的前几条记录" },
        limit: { type: "number", description: "返回数量上限，默认 30，最大 200" },
        offset: { type: "number", description: "分页偏移量，默认 0" },
        fields: { type: "array", items: { type: "string" }, description: "可选，只返回这些字段；支持点路径，例如 mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "fields 的别名" },
    },
    required: ["query"],
});

const LOCAL_DATA_READ_RECORD_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "IndexedDB store 路径，例如 /chat/indexeddb/AiPhoneChatDB/messages" },
        key: { type: "string", description: "记录主键；复杂主键可使用 JSON 字符串" },
        fields: { type: "array", items: { type: "string" }, description: "可选，只返回这些字段；支持点路径，例如 mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "fields 的别名" },
    },
    required: ["path", "key"],
});

const LOCAL_DATA_LIBRARY_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "列出资料目录",
        description: "列出本地资料库虚拟目录、数据源、文件、IndexedDB store 或记录键。",
        parameterSchema: LOCAL_DATA_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "读取资料文件",
        description: "读取本地资料库里的 KV/localStorage JSON 文件，或读取 IndexedDB store 的分页记录。",
        parameterSchema: LOCAL_DATA_READ_FILE_PARAMETER_SCHEMA,
    },
    {
        name: "查看资料字段",
        description: "抽样查看某个资料文件或 IndexedDB store 可用字段，方便后续用 fields/select 只读取部分字段。",
        parameterSchema: LOCAL_DATA_FIELDS_PARAMETER_SCHEMA,
    },
    {
        name: "搜索资料记录",
        description: "在本地资料库指定路径内按关键词搜索记录；可用于查角色、聊天、朋友圈、工具箱等。",
        parameterSchema: LOCAL_DATA_SEARCH_PARAMETER_SCHEMA,
    },
    {
        name: "读取资料记录",
        description: "按主键读取某个 IndexedDB store 中的一条记录。",
        parameterSchema: LOCAL_DATA_READ_RECORD_PARAMETER_SCHEMA,
    },
];

const LOCAL_DATA_LIBRARY_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：本地资料库",
    "用途：浏览、读取和搜索{{user}}小手机里的本地数据，包括角色卡、聊天、朋友圈、记忆、工具箱、设置和应用数据。",
    "",
    "这是一个虚拟文件系统，不是真实源码目录。先列目录，再按需读取或搜索，避免一次读取过多数据。",
    "",
    "常见路径：",
    "- /characters：角色卡与素材",
    "- /chat：聊天联系人、会话、消息和线下模式记录",
    "- /social：朋友圈、小红书、好友申请和社交互动状态",
    "- /memory：长期记忆、核心记忆和事件计数",
    "- /settings：预设、世界书、正则、工具箱和绑定设置",
    "",
    "动作：列出资料目录",
    "参数：",
    "  - path (string): 虚拟目录路径，默认 /",
    "  - limit (number): 返回数量，默认 30，最大 200",
    "  - offset (number): 分页偏移量",
    "示例：",
    '[执行动作:列出资料目录({"path":"/"})]',
    "",
    "动作：读取资料文件",
    "参数：",
    "  - path (string, 必填): KV/localStorage JSON 文件路径，或 IndexedDB store 路径",
    "  - limit (number): 数组或 store 读取数量，默认 30，最大 200",
    "  - offset (number): 分页偏移量",
    "  - fields/select (string[]): 可选，只返回指定字段；支持点路径，例如 mediaData.label",
    "示例：",
    '[执行动作:读取资料文件({"path":"/characters/kv/ai_phone_characters_v1.json","limit":20,"fields":["id","name","persona"]})]',
    "",
    "动作：查看资料字段",
    "参数：",
    "  - path (string, 必填): KV/localStorage JSON 文件路径，或 IndexedDB store 路径",
    "  - sample (number): 抽样记录数，默认 5，最大 50",
    "示例：",
    '[执行动作:查看资料字段({"path":"/chat/indexeddb/AiPhoneChatDB/messages","sample":5})]',
    "",
    "动作：搜索资料记录",
    "参数：",
    "  - path (string): 搜索范围，默认 /",
    "  - query (string, 必填): 搜索关键词；留空时返回前几条记录",
    "  - limit (number): 返回数量，默认 30，最大 200",
    "  - offset (number): 分页偏移量",
    "  - fields/select (string[]): 可选，只返回指定字段；支持点路径，例如 mediaData.label",
    "示例：",
    '[执行动作:搜索资料记录({"path":"/chat","query":"沈既川","limit":30,"fields":["id","role","content","createdAt"]})]',
    "",
    "动作：读取资料记录",
    "参数：",
    "  - path (string, 必填): IndexedDB store 路径，例如 /chat/indexeddb/AiPhoneChatDB/messages",
    "  - key (string, 必填): 记录主键",
    "  - fields/select (string[]): 可选，只返回指定字段；支持点路径，例如 mediaData.label",
    "示例：",
    '[执行动作:读取资料记录({"path":"/chat/indexeddb/AiPhoneChatDB/messages","key":"msg_xxx","fields":["id","content"]})]',
].join("\n");

/* ---------- Lifeline 每日记录套装：财务 / 学习计划 / 饮食体重 / 错题本 ---------- */

const LIFELINE_EMPTY_PARAMETER_SCHEMA = JSON.stringify({ type: "object", properties: {} });

const LIFELINE_FINANCE_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        days: { type: "number", description: "查最近 N 天的支出，默认 7 天，1-120" },
        category: { type: "string", description: "只看某个分类（餐饮/交通/购物/学习/娱乐/医疗/人情/其他），不填=全部" },
    },
});

const LIFELINE_ADD_FINANCE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        amount: { type: "number", description: "金额（元），必须大于 0，必填" },
        category: { type: "string", description: "分类：餐饮/交通/购物/学习/娱乐/医疗/人情/其他（支出）；不填按其他" },
        note: { type: "string", description: "备注/商户名，如 食堂牛肉面" },
        method: { type: "string", enum: ["wechat", "alipay", "cash"], description: "支付方式：wechat 微信 / alipay 支付宝 / cash 现金，默认 wechat" },
        type: { type: "string", enum: ["expense", "income"], description: "expense 支出（默认）/ income 收入" },
        date: { type: "string", description: "日期 YYYY-MM-DD，不填=今天" },
    },
    required: ["amount"],
});

const LIFELINE_PLAN_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        date: { type: "string", description: "只看某天（YYYY-MM-DD）；传了就忽略 days" },
        days: { type: "number", description: "看最近几天的计划，默认 2（今天+明天），1-14" },
    },
});

const LIFELINE_TASK_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        name: { type: "string", description: "任务内容（新增时必填），如 数学定积分 16 题" },
        date: { type: "string", description: "任务日期 YYYY-MM-DD，不填=今天" },
        period: { type: "string", enum: ["morning", "afternoon", "evening"], description: "时段：morning 上午 / afternoon 下午 / evening 晚上，默认下午" },
        subject: { type: "string", description: "科目：数学/金融学/逻辑/英语/政治/生活 等" },
        duration: { type: "number", description: "预计时长（分钟）" },
        taskId: { type: "string", description: "要标记完成的任务 id（来自查看学习计划返回）；传了它就是「标记完成」，不再新增" },
        keyword: { type: "string", description: "不传 taskId 时，按任务名关键词标记今天第一个未完成任务为完成" },
    },
});

const LIFELINE_DIET_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        food: { type: "string", description: "吃了什么，如 黄焖鸡米饭，必填" },
        meal: { type: "string", description: "哪一餐：早餐/午餐/晚餐/加餐/饮品，默认按内容猜" },
        price: { type: "number", description: "这顿花了多少钱（元）；填了会自动同步记一笔餐饮支出" },
        date: { type: "string", description: "日期 YYYY-MM-DD，不填=今天" },
    },
    required: ["food"],
});

const LIFELINE_WEIGHT_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        weight: { type: "number", description: "体重（斤），必填" },
        slot: { type: "string", enum: ["morning", "night"], description: "morning 早上空腹（默认）/ night 晚上睡前" },
        date: { type: "string", description: "日期 YYYY-MM-DD，不填=今天" },
        target: { type: "number", description: "可选，顺便更新目标体重（斤）" },
    },
    required: ["weight"],
});

const LIFELINE_ERROR_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        subject: { type: "string", enum: ["finance", "math", "english", "politics"], description: "只看某科：finance 金融学 / math 数学 / english 英语 / politics 政治；不填=全部" },
        status: { type: "string", enum: ["未掌握", "模糊", "已掌握"], description: "按掌握状态筛选，不填=全部" },
    },
});

const LIFELINE_ERROR_ADD_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        subject: { type: "string", enum: ["finance", "math", "english", "politics"], description: "学科，必填", },
        q: { type: "string", description: "题干，必填；含 LaTeX 公式直接写原生 LaTeX", },
        options: { type: "array", items: { type: "string" }, description: "选项数组，如 ['A. 对','B. 错']" },
        wrong: { type: "string", description: "用户选错的那项" },
        right: { type: "string", description: "正确答案" },
        analysis: { type: "string", description: "错因/解析" },
        type: { type: "string", description: "题型：单选/多选/判断/计算 等" },
        source: { type: "string", description: "来源：如 2026人大/800题/周洋鑫讲义" },
        date: { type: "string", description: "日期 YYYY-MM-DD，不填=今天" },
    },
    required: ["subject", "q"],
});

const LIFELINE_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "查看今日消费",
        description: "查看{{user}}今天在 Lifeline 里记了哪些支出、合计多少钱。",
        parameterSchema: LIFELINE_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查看消费记录",
        description: "查看 Lifeline 最近几天的支出流水，可按分类筛选，并给出窗口内合计。",
        parameterSchema: LIFELINE_FINANCE_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "记一笔账",
        description: "在 Lifeline 记一笔收支。OCR 识别出金额后用这一步落账；用户口头说花了多少钱也直接记。",
        parameterSchema: LIFELINE_ADD_FINANCE_PARAMETER_SCHEMA,
    },
    {
        name: "查看学习计划",
        description: "查看 Lifeline 里某天或最近几天的考研学习任务，带每时段任务和完成进度。",
        parameterSchema: LIFELINE_PLAN_PARAMETER_SCHEMA,
    },
    {
        name: "记录学习任务",
        description: "在 Lifeline 新增一条学习任务，或把已有任务标记完成。传 taskId/keyword=标记完成；否则按 name 新增。",
        parameterSchema: LIFELINE_TASK_PARAMETER_SCHEMA,
    },
    {
        name: "查看今日饮食",
        description: "查看{{user}}今天在 Lifeline 里记录的早午晚吃了什么。",
        parameterSchema: LIFELINE_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "记录饮食",
        description: "在 Lifeline 记一笔吃了什么；填 price 会自动同步一笔餐饮支出。",
        parameterSchema: LIFELINE_DIET_PARAMETER_SCHEMA,
    },
    {
        name: "记录体重",
        description: "在 Lifeline 记一次体重（斤），分早上空腹/晚上睡前；同天自动合并。",
        parameterSchema: LIFELINE_WEIGHT_PARAMETER_SCHEMA,
    },
    {
        name: "查看体重",
        description: "查看 Lifeline 里最新体重、目标体重和累计记录天数；{{user}}问「我体重多少」时用。",
        parameterSchema: LIFELINE_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查看错题本",
        description: "查看 Lifeline 错题本，可按学科（金融学/数学/英语/政治）和掌握状态筛选。",
        parameterSchema: LIFELINE_ERROR_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "录入错题",
        description: "把{{user}}刚错的一道题录进 Lifeline 错题本：学科、题干、选项、错误项、正确项、错因。",
        parameterSchema: LIFELINE_ERROR_ADD_PARAMETER_SCHEMA,
    },
];

function buildLifelineUsageGuide(): string {
    return [
        "以下是你获取指令的返回结果：",
        "「Lifeline 每日记录」是{{user}}自己的生活记录小应用：记账、考研学习计划、饮食体重、错题本都在里面。你直接读写 TA 的真实记录，不要凭空编数据。",
        "",
        "【使用时机】",
        "- {{user}}说「我今天花了/吃了/体重多少/这道题错了/今天学了什么」时，主动调对应工具记下来，别光嘴上应。",
        "- {{user}}问「今天花了多少/我吃了啥/今天计划完成没/我错了哪些题」时，先查再答。",
        "- 查类动作返回的是真实记录，如实转述；写类动作成功后给一句简短确认。",
        "",
        "动作：查看今日消费",
        "说明：今天的支出流水+合计。",
        "示例：[执行动作:查看今日消费({})]",
        "",
        "动作：查看消费记录",
        "参数：days 最近几天（默认7）；category 分类筛选。",
        "示例：[执行动作:查看消费记录({\"days\":7})]",
        "",
        "动作：记一笔账",
        "说明：记一笔收支，amount 必填；OCR 识别屏幕交易拿到金额/商户后，用 amount/note/category/method 落账。",
        "参数：amount 金额(元)；category 分类；note 备注/商户；method wechat/alipay/cash；type expense/income；date YYYY-MM-DD。",
        "示例：[执行动作:记一笔账({\"amount\":15.5,\"category\":\"餐饮\",\"note\":\"食堂牛肉面\",\"method\":\"wechat\"})]",
        "",
        "动作：查看学习计划",
        "说明：默认看今天+明天，带完成进度。",
        "参数：date 指定某天；days 最近几天。",
        "示例：[执行动作:查看学习计划({\"days\":2})]",
        "",
        "动作：记录学习任务",
        "说明：传 taskId 或 keyword=把对应任务标记完成；否则用 name 新增一条任务。",
        "参数：name 任务内容；date/period(上午/下午/晚上)；subject 科目；duration 分钟。",
        "示例：[执行动作:记录学习任务({\"name\":\"数学定积分16题\",\"period\":\"evening\",\"subject\":\"数学\",\"duration\":47})]",
        "示例：[执行动作:记录学习任务({\"keyword\":\"定积分\"})]",
        "",
        "动作：查看今日饮食",
        "说明：今天早午晚吃了什么。",
        "示例：[执行动作:查看今日饮食({})]",
        "",
        "动作：记录饮食",
        "说明：记一笔吃了什么；price 填了会自动同步餐饮支出。",
        "参数：food 吃了什么(必填)；meal 早餐/午餐/晚餐/加餐/饮品；price 多少钱；date。",
        "示例：[执行动作:记录饮食({\"food\":\"黄焖鸡米饭\",\"meal\":\"午餐\",\"price\":22})]",
        "",
        "动作：记录体重",
        "说明：体重单位斤；同天早晚分开记。",
        "参数：weight 体重(必填)；slot morning/night；target 可选更新目标体重。",
        "示例：[执行动作:记录体重({\"weight\":96.5,\"slot\":\"morning\"})]",
        "",
        "动作：查看体重",
        "说明：最新体重、目标体重和累计记录天数；{{user}}问「我体重多少/最近瘦了没」时用。",
        "示例：[执行动作:查看体重({})]",
        "",
        "动作：查看错题本",
        "参数：subject finance/math/english/politics；status 未掌握/模糊/已掌握。",
        "示例：[执行动作:查看错题本({\"subject\":\"math\"})]",
        "",
        "动作：录入错题",
        "说明：用户发错题截图或口述错题后录入。",
        "参数：subject(必填)；q 题干(必填)；options 选项数组；wrong 错项；right 正解；analysis 错因；type/source。",
        "示例：[执行动作:录入错题({\"subject\":\"finance\",\"q\":\"企业部门去杠杆会导致？\",\"options\":[\"A.通胀\",\"B.通缩\"],\"wrong\":\"A\",\"right\":\"B\",\"analysis\":\"企业去杠杆→投资需求收缩→物价下跌\",\"type\":\"单选\",\"source\":\"2026人大\"})]",
    ].join("\n");
}

const TOOLBOX_REST_TOOL_PROPERTIES = {
    name: { type: "string", description: "工具名称，必须唯一" },
    description: { type: "string", description: "工具用途说明，会展示给 AI" },
    endpoint: { type: "string", description: "HTTP/HTTPS 接口地址，支持 {{参数名}} 转义插入；支持 {{{参数名}}} 原样插入完整 URL/路径" },
    method: { type: "string", enum: ["GET", "POST"], description: "请求方式" },
    headers: { type: "object", additionalProperties: { type: "string" }, description: "请求头，支持 {{参数名}} 占位符" },
    bodyTemplate: { type: "string", description: "POST JSON 请求体模板，支持 {{参数名}} 占位符；整项为 {{参数名}} 时会保留原始类型" },
    parameterSchema: { type: "string", description: "AI 可见参数 JSON Schema 字符串" },
    fixedParams: { type: "object", additionalProperties: { type: "string" }, description: "固定参数，不暴露给 AI，例如 api_key" },
    directFetch: { type: "boolean", description: "是否浏览器直连；默认 true" },
};

const TOOLBOX_ADD_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        packageId: { type: "string", description: "目标 AI REST 套件 ID；优先使用 packageId" },
        packageName: { type: "string", description: "目标 AI REST 套件名称；没有 packageId 时使用。留空则创建单件 REST 工具" },
        ...TOOLBOX_REST_TOOL_PROPERTIES,
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
    },
    required: ["name", "description", "endpoint", "method", "parameterSchema"],
});

const TOOLBOX_UPDATE_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要更新的 AI 工具 ID，优先使用 id" },
        name: { type: "string", description: "要更新的 AI 工具名称；没有 id 时使用" },
        updates: {
            type: "object",
            description: "要更新的字段。只能更新 AI 创建的 REST 工具。",
            properties: {
                packageId: { type: "string", description: "移动到目标 AI REST 套件 ID" },
                packageName: { type: "string", description: "移动到目标 AI REST 套件名称" },
                ...TOOLBOX_REST_TOOL_PROPERTIES,
                enabled: { type: "boolean", description: "是否启用" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_REST_TOOL_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要启用/停用的 AI 工具 ID，优先使用 id" },
        name: { type: "string", description: "要启用/停用的 AI 工具名称；没有 id 时使用" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要删除的 AI 工具 ID，优先使用 id" },
        name: { type: "string", description: "要删除的 AI 工具名称；没有 id 时使用" },
    },
});

const TOOLBOX_ADD_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        name: { type: "string", description: "套件名称，必须唯一" },
        description: { type: "string", description: "套件用途说明，会展示给 AI" },
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
    },
    required: ["name", "description"],
});

const TOOLBOX_UPDATE_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要更新的 AI REST 套件 ID，优先使用 id" },
        name: { type: "string", description: "要更新的 AI REST 套件名称；没有 id 时使用" },
        updates: {
            type: "object",
            description: "要更新的字段。只能更新 AI 创建的 REST 套件。",
            properties: {
                name: { type: "string", description: "新的套件名称，必须唯一" },
                description: { type: "string", description: "新的套件用途说明" },
                enabled: { type: "boolean", description: "是否启用" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_REST_PACKAGE_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要启用/停用的 AI REST 套件 ID，优先使用 id" },
        name: { type: "string", description: "要启用/停用的 AI REST 套件名称；没有 id 时使用" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要删除的 AI REST 套件 ID，优先使用 id" },
        name: { type: "string", description: "要删除的 AI REST 套件名称；没有 id 时使用" },
    },
});

const TOOLBOX_COMPOSITE_STEP_SCHEMA = {
    type: "object",
    properties: {
        toolName: { type: "string", description: "要调用的具体动作名称，例如 搜索、读取资料文件、某个 MCP 子工具名或组合工具名" },
        toolType: { type: "string", enum: ["auto", "rest", "internal", "mcp", "composite", "script"], description: "工具类别；不确定时用 auto；script 表示执行一段 JS 中间处理逻辑" },
        toolId: { type: "string", description: "可选，REST/组合工具 ID，用于同名工具时精确定位" },
        serverId: { type: "string", description: "可选，MCP 服务器 ID，用于同名 MCP 工具时精确定位" },
        argsTemplate: { type: "object", description: "传给该步骤的参数模板，支持 {{input.xxx}}、{{last.data}}、{{steps.名称.data}}" },
        script: { type: "string", description: "toolType 为 script 时执行的异步 JS；可直接访问 window、localStorage、fetch、document，并通过 return 返回结果" },
        saveAs: { type: "string", description: "保存该步骤结果的名称，供后续步骤通过 {{steps.名称.data}} 引用" },
    },
};

const TOOLBOX_COMPOSITE_TOOL_PROPERTIES = {
    name: { type: "string", description: "组合工具名称，必须唯一" },
    description: { type: "string", description: "组合工具用途说明，会展示给 AI" },
    parameterSchema: { type: "string", description: "组合工具对 AI 暴露的参数 JSON Schema 字符串" },
    steps: { type: "array", items: TOOLBOX_COMPOSITE_STEP_SCHEMA, description: "顺序执行的步骤列表" },
    outputTemplate: { type: "string", description: "最终返回模板，支持 {{last.data}} 和 {{steps.名称.data}}；留空则返回步骤摘要" },
};

const TOOLBOX_ADD_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        packageId: { type: "string", description: "目标 AI 组合工具套件 ID；优先使用 packageId" },
        packageName: { type: "string", description: "目标 AI 组合工具套件名称；没有 packageId 时使用。留空则创建单件组合工具" },
        ...TOOLBOX_COMPOSITE_TOOL_PROPERTIES,
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
    },
    required: ["name", "description", "parameterSchema", "steps"],
});

const TOOLBOX_UPDATE_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要更新的 AI 组合工具 ID，优先使用 id" },
        name: { type: "string", description: "要更新的 AI 组合工具名称；没有 id 时使用" },
        updates: {
            type: "object",
            description: "要更新的字段。只能更新 AI 创建的组合工具。",
            properties: {
                packageId: { type: "string", description: "移动到目标 AI 组合工具套件 ID" },
                packageName: { type: "string", description: "移动到目标 AI 组合工具套件名称" },
                ...TOOLBOX_COMPOSITE_TOOL_PROPERTIES,
                enabled: { type: "boolean", description: "是否启用" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_COMPOSITE_TOOL_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要启用/停用的 AI 组合工具 ID，优先使用 id" },
        name: { type: "string", description: "要启用/停用的 AI 组合工具名称；没有 id 时使用" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要删除的 AI 组合工具 ID，优先使用 id" },
        name: { type: "string", description: "要删除的 AI 组合工具名称；没有 id 时使用" },
    },
});

const TOOLBOX_ADD_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        name: { type: "string", description: "组合工具套件名称，必须唯一" },
        description: { type: "string", description: "套件用途说明，会展示给 AI" },
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
    },
    required: ["name", "description"],
});

const TOOLBOX_UPDATE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要更新的 AI 组合工具套件 ID，优先使用 id" },
        name: { type: "string", description: "要更新的 AI 组合工具套件名称；没有 id 时使用" },
        updates: {
            type: "object",
            description: "要更新的字段。只能更新 AI 创建的组合工具套件。",
            properties: {
                name: { type: "string", description: "新的套件名称，必须唯一" },
                description: { type: "string", description: "新的套件用途说明" },
                enabled: { type: "boolean", description: "是否启用" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_COMPOSITE_PACKAGE_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要启用/停用的 AI 组合工具套件 ID，优先使用 id" },
        name: { type: "string", description: "要启用/停用的 AI 组合工具套件名称；没有 id 时使用" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要删除的 AI 组合工具套件 ID，优先使用 id" },
        name: { type: "string", description: "要删除的 AI 组合工具套件名称；没有 id 时使用" },
    },
});

const TOOLBOX_MANAGEMENT_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "添加REST套件",
        description: "添加一个 AI 创建的 REST 工具套件，用来分组管理多个 REST 子工具。",
        parameterSchema: TOOLBOX_ADD_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "更新REST套件",
        description: "更新 AI 自己创建的 REST 工具套件；不允许更新用户手动创建或内置套件。",
        parameterSchema: TOOLBOX_UPDATE_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "设置REST套件启用",
        description: "启用或停用 AI 自己创建的 REST 工具套件；不允许操作用户手动创建或内置套件。",
        parameterSchema: TOOLBOX_SET_REST_PACKAGE_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除REST套件",
        description: "删除 AI 自己创建的 REST 工具套件，并删除该套件下 AI 自己创建的 REST 子工具。",
        parameterSchema: TOOLBOX_DELETE_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "添加REST工具",
        description: "添加一个 AI 创建的 REST 工具；可作为单件工具，也可放入 AI 自己创建的 REST 套件。",
        parameterSchema: TOOLBOX_ADD_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "更新REST工具",
        description: "更新 AI 自己创建的 REST 工具；不允许更新用户手动创建或内置工具。",
        parameterSchema: TOOLBOX_UPDATE_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "设置REST工具启用",
        description: "启用或停用 AI 自己创建的 REST 工具；不允许操作用户手动创建或内置工具。",
        parameterSchema: TOOLBOX_SET_REST_TOOL_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除REST工具",
        description: "删除 AI 自己创建的 REST 工具；不允许删除用户手动创建或内置工具。",
        parameterSchema: TOOLBOX_DELETE_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "添加组合工具套件",
        description: "添加一个 AI 创建的组合工具套件，用来分组管理多个组合工具。",
        parameterSchema: TOOLBOX_ADD_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "更新组合工具套件",
        description: "更新 AI 自己创建的组合工具套件；不允许更新用户手动创建或内置套件。",
        parameterSchema: TOOLBOX_UPDATE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "设置组合工具套件启用",
        description: "启用或停用 AI 自己创建的组合工具套件；不允许操作用户手动创建或内置套件。",
        parameterSchema: TOOLBOX_SET_COMPOSITE_PACKAGE_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除组合工具套件",
        description: "删除 AI 自己创建的组合工具套件，并删除该套件下 AI 自己创建的组合工具。",
        parameterSchema: TOOLBOX_DELETE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "添加组合工具",
        description: "添加一个 AI 创建的组合工具；可作为单件组合工具，也可放入 AI 自己创建的组合工具套件。",
        parameterSchema: TOOLBOX_ADD_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "更新组合工具",
        description: "更新 AI 自己创建的组合工具；不允许更新用户手动创建或内置组合工具。",
        parameterSchema: TOOLBOX_UPDATE_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "设置组合工具启用",
        description: "启用或停用 AI 自己创建的组合工具；不允许操作用户手动创建或内置组合工具。",
        parameterSchema: TOOLBOX_SET_COMPOSITE_TOOL_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除组合工具",
        description: "删除 AI 自己创建的组合工具；不允许删除用户手动创建或内置组合工具。",
        parameterSchema: TOOLBOX_DELETE_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
];

const TOOLBOX_MANAGEMENT_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：工具箱管理",
    "用途：创建和维护你自己写入的 REST 工具、REST 套件、组合工具和组合工具套件。你只能修改 createdBy 为 ai 的内容，不能修改用户手动创建或内置内容。",
    "",
    "使用建议：",
    "- 如果不确定现有工具结构，先用「本地资料库」读取 /settings/kv/ai_phone_rest_tool_packages_v1.json、/settings/kv/ai_phone_rest_tools_v1.json、/settings/kv/ai_phone_composite_tool_packages_v1.json 和 /settings/kv/ai_phone_composite_tools_v1.json。",
    "- 单个独立能力直接创建单件 REST 工具；多个同类别工具建议先创建 REST 套件，再往套件里添加子工具。",
    "- REST 套件采用懒加载：第一轮只提供套件名称、描述和获取指令方式；需要使用套件时再获取子工具说明，以节省上下文。",
    "- 组合工具用于把多个已有动作按顺序串起来，可跨 REST、MCP、内置能力和其他组合工具；单个流程建单件组合工具，同类流程较多时先建组合工具套件。",
    "- 组合工具步骤的 argsTemplate 支持 {{input.xxx}}、{{last.data}}、{{steps.名称.data}}，用于把用户参数和上一步结果传给下一步。",
    "- 每一步结果都有 data；如果 data 是合法 JSON，系统会额外提供 json，可通过 {{steps.名称.json}} 或脚本里的 steps.名称.json 直接使用对象。",
    "- 组合工具支持 script 步骤：脚本可使用 input、steps、last、args、context，也可直接访问 window、localStorage、fetch、document；支持 await，必须用 return 返回结果。",
    "- 添加或更新前，保证 parameterSchema 是合法 JSON Schema 字符串。",
    "- endpoint 中 {{参数名}} 会按 URL 参数转义，适合 query 参数；{{{参数名}}} 会原样插入，适合把完整网址拼进路径，例如 Jina Reader 的 https://r.jina.ai/http://{{{url}}}。",
    "- bodyTemplate 如果填写，必须是合法 JSON 字符串，可以包含 {{参数名}} 占位符；整项写成 \"{{参数名}}\" 时会保留原始类型。",
    "",
    "动作：添加REST套件",
    "参数：",
    "  - name (string, 必填): 套件名称，必须唯一",
    "  - description (string, 必填): 套件用途说明",
    "  - enabled (boolean): 是否启用，默认 true",
    "示例：",
    '[执行动作:添加REST套件({"name":"网页资料工具","description":"搜索、读取和整理网页内容","enabled":true})]',
    "",
    "动作：更新REST套件",
    "参数：",
    "  - id/name: 要更新的 AI 套件",
    "  - updates (object, 必填): 要更新的字段",
    "示例：",
    '[执行动作:更新REST套件({"name":"网页资料工具","updates":{"description":"网页搜索、正文读取和内容整理"}})]',
    "",
    "动作：设置REST套件启用",
    "参数：",
    "  - id/name: 要启用或停用的 AI 套件",
    "  - enabled (boolean, 必填): true 启用，false 停用",
    "示例：",
    '[执行动作:设置REST套件启用({"name":"网页资料工具","enabled":true})]',
    "",
    "动作：删除REST套件",
    "参数：",
    "  - id/name: 要删除的 AI 套件",
    "示例：",
    '[执行动作:删除REST套件({"name":"网页资料工具"})]',
    "",
    "动作：添加REST工具",
    "参数：",
    "  - packageId/packageName: 目标 AI REST 套件；留空则创建单件 REST 工具",
    "  - name (string, 必填): 工具名称，必须唯一",
    "  - description (string, 必填): 工具用途说明",
    "  - endpoint (string, 必填): HTTP/HTTPS 接口地址，{{参数名}} 会转义，{{{参数名}}} 会原样插入",
    "  - method (string, 必填): GET 或 POST",
    "  - headers (object): 请求头",
    "  - bodyTemplate (string): POST JSON 请求体模板",
    "  - parameterSchema (string, 必填): AI 可见参数 JSON Schema 字符串",
    "  - fixedParams (object): 固定参数，例如 api_key",
    "  - directFetch (boolean): 是否直连，默认 true",
    "  - enabled (boolean): 是否启用，默认 true",
    "示例：",
    '[执行动作:添加REST工具({"packageName":"网页资料工具","name":"读取网页正文","description":"读取网页 URL 并返回正文","endpoint":"https://r.jina.ai/http://{{{url}}}","method":"GET","directFetch":false,"parameterSchema":"{\\"type\\":\\"object\\",\\"properties\\":{\\"url\\":{\\"type\\":\\"string\\",\\"description\\":\\"网页 URL，建议不带 https:// 或 http://\\"}},\\"required\\":[\\"url\\"]}"})]',
    "",
    "动作：更新REST工具",
    "参数：",
    "  - id/name: 要更新的 AI 工具",
    "  - updates (object, 必填): 要更新的字段",
    "示例：",
    '[执行动作:更新REST工具({"name":"读取网页正文","updates":{"endpoint":"https://api.example.com/read","bodyTemplate":"{\\"input\\":\\"{{url}}\\"}"}})]',
    "",
    "动作：设置REST工具启用",
    "参数：",
    "  - id/name: 要启用或停用的 AI 工具",
    "  - enabled (boolean, 必填): true 启用，false 停用",
    "示例：",
    '[执行动作:设置REST工具启用({"name":"读取网页正文","enabled":true})]',
    "",
    "动作：删除REST工具",
    "参数：",
    "  - id/name: 要删除的 AI 工具",
    "示例：",
    '[执行动作:删除REST工具({"name":"读取网页正文"})]',
    "",
    "动作：添加组合工具套件",
    "参数：",
    "  - name (string, 必填): 组合工具套件名称，必须唯一",
    "  - description (string, 必填): 套件用途说明",
    "  - enabled (boolean): 是否启用，默认 true",
    "示例：",
    '[执行动作:添加组合工具套件({"name":"网页研究流程","description":"搜索、读取、整理和记录网页资料","enabled":true})]',
    "",
    "动作：添加组合工具",
    "参数：",
    "  - packageId/packageName: 目标 AI 组合工具套件；留空则创建单件组合工具",
    "  - name (string, 必填): 组合工具名称，必须唯一",
    "  - description (string, 必填): 组合工具用途说明",
    "  - parameterSchema (string, 必填): AI 调用该组合工具时可见的参数 JSON Schema 字符串",
    "  - steps (array, 必填): 顺序执行步骤。普通步骤包含 toolName、toolType(auto/rest/internal/mcp/composite)、argsTemplate、saveAs；脚本步骤使用 toolType=script、script、saveAs",
    "  - outputTemplate (string): 最终返回模板，支持 {{last.data}} 和 {{steps.名称.data}}",
    "  - enabled (boolean): 是否启用，默认 true",
    "示例：",
    '[执行动作:添加组合工具({"packageName":"网页研究流程","name":"搜索并整理网页","description":"搜索关键词并把搜索结果整理为可继续使用的摘要","parameterSchema":"{\\"type\\":\\"object\\",\\"properties\\":{\\"query\\":{\\"type\\":\\"string\\",\\"description\\":\\"搜索关键词\\"}},\\"required\\":[\\"query\\"]}","steps":[{"toolName":"搜索","toolType":"rest","argsTemplate":{"query":"{{input.query}}"},"saveAs":"search"}],"outputTemplate":"{{steps.search.data}}","enabled":true})]',
    "脚本步骤示例：",
    '{"toolType":"script","saveAs":"matched","script":"const contacts = JSON.parse(steps.contacts.data); const characters = JSON.parse(steps.characters.data); return contacts.map(c => ({ contactName: c.value?.name, characterName: characters.find(x => x.id === c.value?.characterId)?.name || \\"\\" }));"}',
    "",
    "动作：更新组合工具 / 更新组合工具套件 / 设置组合工具启用 / 设置组合工具套件启用 / 删除组合工具 / 删除组合工具套件",
    "说明：与 REST 工具对应动作类似，只能操作 AI 自己创建的组合工具或组合工具套件。",
].join("\n");

const BUILTIN_INTERNAL_CAPABILITIES: InternalCapabilityConfig[] = [
    {
        id: REALITY_BRIDGE_CAPABILITY_ID,
        name: "现实桥",
        description: "你活在{{user}}的小手机里，而现实桥是通向 TA 真实世界的那座桥：透过它能看见{{user}}真实手机上的实时状态（电量、健康数据等），也能在 TA 的真实手机上做事（运行 TA 登记的快捷指令）。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: HUAWEI_SHELL_CAPABILITY_ID,
        name: "华为手机",
        description: "华为壳是通向{{user}}真实华为手机的桥：能看见 TA 手机的实时状态（电量、音量、天气、位置、当前应用、通知），能帮 TA 自动记账（微信/支付宝分账），也能在 TA 手机上做事（打开应用、点击、输入、滑动、按键、专注模式、定时息屏）。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: MEMORY_WRITE_CAPABILITY_ID,
        name: "写入记忆",
        description: "将明确、稳定、长期有价值的信息写入长期记忆。仅限关系里程碑、长期偏好、身份信息、重要约定；禁止写入短期情绪、普通寒暄、猜测或未确认内容。",
        enabled: false,
        mode: "confirm",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: NOTE_WALL_CAPABILITY_ID,
        name: "便签墙",
        description: "公共社区便签墙相关服务。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: MUSIC_CONTROL_CAPABILITY_ID,
        name: "网易云音乐",
        description: "控制{{user}}小手机里的音乐播放，查看{{user}}小手机里的音乐库、网易云歌单和播放列表。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: CALENDAR_MANAGEMENT_CAPABILITY_ID,
        name: "日历管理",
        description: "查看、添加、修改和取消当前角色的日程安排。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: AGENT_COMPUTER_CAPABILITY_ID,
        name: "角色电脑",
        description: "你拥有一台自己的云端小电脑（持久硬盘 + 终端）：可以自己写文件记录生活、翻看旧文件，把电脑里的文件发给{{user}}，也能在终端里执行 shell 命令。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: SEND_FILE_CAPABILITY_ID,
        name: "发送文件",
        description: "将外部 URL 文件（音频、图片、视频）发送给{{user}}，{{user}}可以直接播放或下载。用于配合其他工具生成内容后交付给用户。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: LOCAL_DATA_LIBRARY_CAPABILITY_ID,
        name: "本地资料库",
        description: "浏览、读取和搜索{{user}}小手机里的本地数据，包括角色卡、聊天、朋友圈、记忆、工具箱、设置和应用数据。",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: LIFELINE_CAPABILITY_ID,
        name: "Lifeline 每日记录",
        description: "{{user}}的每日记录应用：考研学习计划、财务记账、饮食与体重、错题本。你可以直接读写 TA 的真实记录——记账、排学习任务、记吃喝和体重、录错题、查进度。",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: TOOLBOX_MANAGEMENT_CAPABILITY_ID,
        name: "工具箱管理",
        description: "创建、更新、启用、停用和删除 AI 自己创建的 REST 工具、REST 套件、组合工具和组合工具套件；不会修改用户手动创建或内置内容。",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: TIMED_WAKE_CAPABILITY_ID,
        name: "稍后主动联系",
        description: "让角色约定「过一会儿主动联系对方」：现在设定一个延时与想法，到点后由角色决定主动发消息或静默（不是睡觉醒来）。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
];

export function loadInternalCapabilities(): InternalCapabilityConfig[] {
    if (typeof window === "undefined") return BUILTIN_INTERNAL_CAPABILITIES.map(item => ({ ...item }));
    try {
        const raw = kvGet(INTERNAL_CAPABILITIES_KEY);
        const items: InternalCapabilityConfig[] = raw ? JSON.parse(raw) : [];
        return ensureBuiltinInternalCapabilities(items);
    } catch {
        return ensureBuiltinInternalCapabilities([]);
    }
}

export function saveInternalCapabilities(items: InternalCapabilityConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(INTERNAL_CAPABILITIES_KEY, JSON.stringify(items));
}

export function getInternalCapability(id: string): InternalCapabilityConfig | null {
    return loadInternalCapabilities().find(item => item.id === id) || null;
}

export function getEnabledInternalCapabilities(appId?: string): InternalCapabilityConfig[] {
    if (appId !== "chat" && appId !== "group_chat") return [];
    const enabled = loadInternalCapabilities().filter(item => {
        if (!item.enabled || item.mode === "off") return false;
        // 角色电脑是可插拔模块：没连接就不注入，模型完全看不见
        if (item.id === AGENT_COMPUTER_CAPABILITY_ID && !isAgentComputerConfigured()) return false;
        return true;
    });
    // 华为手机桥与 iOS 现实桥都叫「通向真实手机的桥」：华为启用时排除现实桥，
    // 避免模型同时拿到两套相似工具而分不清。仅注入层排除，能力卡片与设置页保持原样。
    if (enabled.some(item => item.id === HUAWEI_SHELL_CAPABILITY_ID)) {
        return enabled.filter(item => item.id !== REALITY_BRIDGE_CAPABILITY_ID);
    }
    return enabled;
}

export function getInternalCapabilityToolDefinition(capability: InternalCapabilityConfig): InternalToolDefinition | null {
    if (capability.id === MEMORY_WRITE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: MEMORY_WRITE_PARAMETER_SCHEMA,
            usageGuide: MEMORY_WRITE_USAGE_GUIDE,
        };
    }
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: NOTE_WALL_USAGE_GUIDE,
        };
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: MUSIC_CONTROL_USAGE_GUIDE,
        };
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: CALENDAR_MANAGEMENT_USAGE_GUIDE,
        };
    }
    if (capability.id === AGENT_COMPUTER_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: AGENT_COMPUTER_PARAMETER_SCHEMA,
            usageGuide: buildAgentComputerUsageGuide(),
        };
    }
    if (capability.id === SEND_FILE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: SEND_FILE_PARAMETER_SCHEMA,
            usageGuide: SEND_FILE_USAGE_GUIDE,
        };
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: LOCAL_DATA_LIBRARY_USAGE_GUIDE,
        };
    }
    if (capability.id === LIFELINE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: buildLifelineUsageGuide(),
        };
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: TOOLBOX_MANAGEMENT_USAGE_GUIDE,
        };
    }
    if (capability.id === TIMED_WAKE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: TIMED_WAKE_PARAMETER_SCHEMA,
            usageGuide: TIMED_WAKE_USAGE_GUIDE,
        };
    }
    if (capability.id === REALITY_BRIDGE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: buildRealityBridgeUsageGuide(),
        };
    }
    if (capability.id === HUAWEI_SHELL_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: buildHuaweiShellUsageGuide(),
        };
    }
    return null;
}

/* ---------- 现实桥套装：固定子工具 + 用户自定义数据项动态生成 ---------- */

const REALITY_BRIDGE_READ_ALL_TOOL: InternalToolDefinition = {
    name: "查看全部手机数据",
    description: "读取{{user}}真实手机上传的全部状态快照（电量、健康数据等），每项附带更新时间。",
    parameterSchema: "{}",
};

function realityBridgeSubTools(): InternalToolDefinition[] {
    const shortcutTools = loadBridgeShortcutActions()
        .filter(action => action.enabled)
        .map(action => ({
            name: action.name,
            description: `${action.description || "执行用户登记的 iPhone 快捷指令"}（${action.deliveryMode === "email" ? "收到触发邮件后自动" : "点击系统通知后"}运行“${action.shortcutName}”）`,
            parameterSchema: JSON.stringify(parseBridgeActionParameterSchema(action.parameterSchema) || {}),
            usageGuide: action.resultMode === "none"
                ? "命令成功送达只表示已经排队；不要声称现实动作已经完成。"
                : `需要等待 iPhone 回传${action.resultMode === "image" ? "图片" : "文本结果"}后才能判断是否完成。`,
        }));
    const dataItems = loadBridgeDataItems();
    const dataTools = dataItems.map(item => ({
        name: item.name,
        description: `${item.description}（数据由{{user}}的快捷指令定期上传到真实手机快照，返回内容附带更新时间）`,
        parameterSchema: "{}",
    }));
    // 一个数据项都没建时不要把「查看全部手机数据」交给角色：它读的就是数据项的
    // 快照，没有数据项就必然空手而归——角色白跑一轮，还会挤掉本该调用的快捷动作。
    return [
        ...shortcutTools,
        WRITE_REAL_CALENDAR_TOOL_DEFINITION,
        ...(dataItems.length > 0 ? [REALITY_BRIDGE_READ_ALL_TOOL] : []),
        ...dataTools,
    ];
}

function buildRealityBridgeUsageGuide(): string {
    const lines = [
        "以下是你获取指令的返回结果：",
        "「现实桥」是从小手机通往{{user}}真实世界的桥——桥那头就是 TA 的真实手机。你可以透过桥看见 TA 现实中的状态，也能在 TA 的真实手机上执行动作。可用动作如下。",
    ];
    for (const action of loadBridgeShortcutActions().filter(item => item.enabled)) {
        lines.push(
            "",
            `动作：${action.name}`,
            `说明：${action.description || "执行用户登记的 iPhone 快捷指令"}。${action.deliveryMode === "email" ? "系统发送触发邮件，由 iPhone 自动化运行" : "系统向手机发送通知，用户点击后运行"}“${action.shortcutName}”。`,
            action.resultMode === "none"
                ? "结果：只返回是否成功排队，不代表手机动作已经完成。"
                : `结果：等待手机回传${action.resultMode === "image" ? "图片" : "文本"}，最长 ${action.expiresInSeconds} 秒。`,
        );
    }
    lines.push(
        "",
        "动作：写真实手机日历",
        "说明：把一条日程写到{{user}}真实手机的系统日历（不是 App 内守护日历）。用户提到考试、复诊、纪念日要落到手机日历时用。",
        "示例：[执行动作:写真实手机日历({\"title\":\"人大金融模考\",\"date\":\"2026-10-15\",\"startTime\":\"08:30\",\"endTime\":\"11:30\"})]",
    );
    const dataItems = loadBridgeDataItems();
    if (dataItems.length > 0) {
        lines.push(
            "",
            "动作：查看全部手机数据",
            "说明：读取{{user}}手机上传的全部状态快照，每项附带更新时间。",
            "示例：[执行动作:查看全部手机数据({})]",
        );
    }
    for (const item of dataItems) {
        lines.push(
            "",
            `动作：${item.name}`,
            `说明：${item.description}（返回内容附带更新时间）`,
            `示例：[执行动作:${item.name}({})]`,
        );
    }
    return lines.join("\n");
}

/* ---------- 华为壳套装：真实华为手机的查看 / 操控 / 专注守护 ---------- */

const HUAWEI_EMPTY_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {},
});

const HUAWEI_NOTIFICATIONS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        limit: { type: "number", description: "返回最近多少条通知，1-50，默认 10（可在 设置 → 华为壳 修改默认值）" },
    },
});

const HUAWEI_PAYMENTS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        limit: { type: "number", description: "返回最近多少笔，1-100，默认 20（可在 设置 → 华为壳 修改默认值）" },
        source: { type: "string", enum: ["all", "wechat", "alipay"], description: "按来源筛选：all=全部（微信+支付宝分开展示），wechat=只看微信，alipay=只看支付宝，默认全部" },
    },
});

const HUAWEI_OPEN_APP_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        packageName: { type: "string", description: "应用包名，例如微信 com.tencent.mm、支付宝 com.eg.android.AlipayGphone" },
    },
    required: ["packageName"],
});

const HUAWEI_CLICK_TEXT_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        text: { type: "string", description: "要点击的屏幕文字，必须与屏幕上显示的文字一致" },
    },
    required: ["text"],
});

const HUAWEI_INPUT_TEXT_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        text: { type: "string", description: "要写入当前输入框的文字" },
    },
    required: ["text"],
});

const HUAWEI_SWIPE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        x1: { type: "number", description: "起点横坐标，归一化 0-1000" },
        y1: { type: "number", description: "起点纵坐标，归一化 0-1000" },
        x2: { type: "number", description: "终点横坐标，归一化 0-1000" },
        y2: { type: "number", description: "终点纵坐标，归一化 0-1000" },
    },
    required: ["x1", "y1", "x2", "y2"],
});

const HUAWEI_PRESS_KEY_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        key: { type: "string", enum: ["home", "back", "recents", "notifications", "quick_settings", "lock_screen"], description: "home=回到桌面 / back=返回 / recents=最近任务 / notifications=下拉通知栏 / quick_settings=快捷开关 / lock_screen=锁屏" },
    },
    required: ["key"],
});

const HUAWEI_FOCUS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        durationMin: { type: "number", description: "专注时长（分钟），1-240；不填用默认值（可在 设置 → 华为壳 修改）" },
    },
});

const HUAWEI_SCREEN_BREAK_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        seconds: { type: "number", description: "多少秒后自动息屏，5-3600；不填用默认值（可在 设置 → 华为壳 修改）" },
    },
});

const HUAWEI_SEND_REMINDER_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        title: { type: "string", description: "提醒标题，简短有力" },
        content: { type: "string", description: "提醒正文，说清楚要提醒什么" },
        openApp: { type: "string", description: "可选：点击通知后打开的应用包名，例如微信 com.tencent.mm；不填点击回到小手机" },
    },
    required: ["title", "content"],
});

const HUAWEI_WECHAT_MESSAGES_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        limit: { type: "number", description: "返回最近多少条微信消息，1-50，默认 10（可在 设置 → 华为壳 修改默认值）" },
    },
});

const HUAWEI_VOLUME_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        stream: { type: "string", enum: ["media", "alarm", "ring"], description: "音量类型：media=媒体 / alarm=闹钟 / ring=铃声，默认 media" },
        value: { type: "number", description: "目标音量 0-100" },
    },
    required: ["value"],
});

const HUAWEI_BRIGHTNESS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        value: { type: "number", description: "屏幕亮度百分比 0-100（首次需授权修改系统设置）" },
    },
    required: ["value"],
});

const HUAWEI_CLIPBOARD_WRITE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        text: { type: "string", description: "要写入手机剪贴板的文本" },
    },
    required: ["text"],
});

const HUAWEI_OPEN_URL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        url: { type: "string", description: "要打开的网页链接（http/https），例如 https://www.baidu.com" },
    },
    required: ["url"],
});

const HUAWEI_READ_FILE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "文件路径；不填默认定位到 Download 下载目录（传目录会列出其中文件）" },
    },
});

const HUAWEI_SHELL_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "查看手机状态",
        description: "读取{{user}}华为手机实时状态：电量、音量、网络、无障碍、悬浮球、门禁锁 App 数量。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "实时天气",
        description: "读取{{user}}当前位置的实时天气（自动定位，不写死城市）：温度、体感、湿度、降水、风力。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查询位置",
        description: "读取{{user}}华为手机当前经纬度定位。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查看当前应用",
        description: "读取{{user}}华为手机此刻前台正在使用的应用。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查看通知",
        description: "读取{{user}}华为手机最近的通知列表（需通知使用权）。",
        parameterSchema: HUAWEI_NOTIFICATIONS_PARAMETER_SCHEMA,
    },
    {
        name: "查看记账",
        description: "读取自动记账：{{user}}华为手机上微信/支付宝的支付记录，按来源 App 分账展示，可按来源筛选。",
        parameterSchema: HUAWEI_PAYMENTS_PARAMETER_SCHEMA,
    },
    {
        name: "读取微信消息",
        description: "读取{{user}}微信（com.tencent.mm）最近的消息：来自通知监听缓存，需通知使用权；微信支付归微信账本。",
        parameterSchema: HUAWEI_WECHAT_MESSAGES_PARAMETER_SCHEMA,
    },
    {
        name: "打开应用",
        description: "在{{user}}华为手机上打开指定应用（包名）。",
        parameterSchema: HUAWEI_OPEN_APP_PARAMETER_SCHEMA,
    },
    {
        name: "点击文字",
        description: "在{{user}}华为手机当前屏幕上按文字点击（需无障碍服务）。",
        parameterSchema: HUAWEI_CLICK_TEXT_PARAMETER_SCHEMA,
    },
    {
        name: "输入文字",
        description: "向{{user}}华为手机当前输入框写入文字（需无障碍服务）。",
        parameterSchema: HUAWEI_INPUT_TEXT_PARAMETER_SCHEMA,
    },
    {
        name: "滑动屏幕",
        description: "在{{user}}华为手机屏幕上滑动（坐标归一化 0-1000，需无障碍服务）。",
        parameterSchema: HUAWEI_SWIPE_PARAMETER_SCHEMA,
    },
    {
        name: "按键操作",
        description: "向{{user}}华为手机发送系统按键：home/back/recents/notifications/quick_settings/lock_screen。",
        parameterSchema: HUAWEI_PRESS_KEY_PARAMETER_SCHEMA,
    },
    {
        name: "专注模式",
        description: "帮{{user}}开启华为手机专注模式：锁全机（除壳外一切前台拦截回桌面）durationMin 分钟。",
        parameterSchema: HUAWEI_FOCUS_PARAMETER_SCHEMA,
    },
    {
        name: "定时息屏",
        description: "让{{user}}华为手机在 seconds 秒后自动息屏（护眼/睡前用）。",
        parameterSchema: HUAWEI_SCREEN_BREAK_PARAMETER_SCHEMA,
    },
    {
        name: "发送提醒",
        description: "主动在{{user}}真实手机上弹一条本地通知提醒（标题 + 内容，可选点击后打开的应用包名）。",
        parameterSchema: HUAWEI_SEND_REMINDER_PARAMETER_SCHEMA,
    },
    {
        name: "查看设备详情",
        description: "读取{{user}}华为手机设备详情：存储总/可用、内存、机型型号、系统版本、电池温度、运行时长。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "调节音量",
        description: "设置{{user}}华为手机媒体/闹钟/铃声音量（0-100）。",
        parameterSchema: HUAWEI_VOLUME_PARAMETER_SCHEMA,
    },
    {
        name: "调节亮度",
        description: "设置{{user}}华为手机屏幕亮度百分比（0-100），需「修改系统设置」权限。",
        parameterSchema: HUAWEI_BRIGHTNESS_PARAMETER_SCHEMA,
    },
    {
        name: "读取剪贴板",
        description: "读取{{user}}华为手机当前剪贴板文本。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "写入剪贴板",
        description: "把文本写入{{user}}华为手机剪贴板。",
        parameterSchema: HUAWEI_CLIPBOARD_WRITE_PARAMETER_SCHEMA,
    },
    {
        name: "打开网页",
        description: "在{{user}}华为手机上用系统浏览器打开指定网页链接。",
        parameterSchema: HUAWEI_OPEN_URL_PARAMETER_SCHEMA,
    },
    {
        name: "读取文件",
        description: "读取{{user}}华为手机上的文件内容（文本/图片），默认定位到 Download 下载目录，供备份查看。",
        parameterSchema: HUAWEI_READ_FILE_PARAMETER_SCHEMA,
    },
    {
        name: "语音转文字",
        description: "在{{user}}华为手机上开始聆听：{{user}}对着手机说话，识别文本同步进当前对话。当{{user}}说「你听我说」「我想说话」或用声音表达时优先用。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "发起语音通话",
        description: "char 主动给{{user}}真实手机拨语音电话：手机像来电话一样响铃+震动，{{user}}在来电界面接听后进入双向语音对话（铃声开关与时长可在设置页调整）。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "识别屏幕交易",
        description: "截取{{user}}华为手机当前屏幕并识别交易信息（金额/商家/来源，OCR 引擎可在设置页配置），识别结果自动入账并同步进对话。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查询行踪足迹",
        description: "查询{{user}}的语义行踪足迹：最近到过家/学校/商场等地点的历史记录（位置隐私按设置页模式对外语义化）。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"days\":{\"type\":\"number\",\"description\":\"查询最近 N 天的足迹（1-30，默认 3）\",\"minimum\":1,\"maximum\":30}}}",
    },
    {
        name: "查看健康数据",
        description: "查看{{user}}穿戴设备（华为手表/手环，经 Gadgetbridge 导出）的健康快照：今日步数、最新心率、压力、活动千卡、睡眠。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "写手机日历",
        description: "把一条日程写进{{user}}真实华为手机日历：壳已连接时拉起华为日历新建事件页并预填好标题/时间/备注，用户确认即写入；壳未连接时降级存为本地日程，连接后可补推。",
        parameterSchema: JSON.stringify({
            type: "object",
            properties: {
                title: { type: "string", description: "日程标题" },
                date: { type: "string", description: "日期 YYYY-MM-DD，例如 2026-10-10" },
                startTime: { type: "string", description: "开始时间 HH:mm，例如 09:00" },
                endTime: { type: "string", description: "结束时间 HH:mm，可选，默认开始时间后 1 小时" },
                note: { type: "string", description: "备注，可选" },
            },
            required: ["title", "date", "startTime"],
        }),
    },
    {
        name: "查看本地日程",
        description: "查看壳未连接时降级暂存到本地的手机日程清单（连接壳后会补推到华为日历）。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "设置起床闹钟",
        description: "设置每天到点在{{user}}真实手机响铃+弹通知喊 TA 起床学习（同一天只响一次）。{{user}}说「明天 X 点叫我起床/喊我学习」时用。",
        parameterSchema: JSON.stringify({
            type: "object",
            properties: {
                time: { type: "string", description: "起床时间 HH:mm，例如 07:00" },
                message: { type: "string", description: "可选：响铃时附带的留言/激励话" },
            },
            required: ["time"],
        }),
    },
    {
        name: "取消起床闹钟",
        description: "取消已设置的起床学习闹钟。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "记一笔账到 Lifeline",
        description: "手动给{{user}}的 Lifeline（学习生活记录 App）记一笔支出：金额/分类/备注/来源。{{user}}口头说「我今天花了 X 买了 Y」时用。",
        parameterSchema: JSON.stringify({
            type: "object",
            properties: {
                amount: { type: "number", description: "金额（数字，正数）" },
                category: { type: "string", description: "分类：餐饮/零食/饮料/购物/交通/娱乐/学习/其他，默认 其他" },
                note: { type: "string", description: "备注，如买了什么" },
                source: { type: "string", description: "可选：来源，微信/支付宝/现金，默认 现金" },
            },
            required: ["amount"],
        }),
    },
    {
        name: "查看 Lifeline 记账",
        description: "读 Lifeline 最近记账记录 + 今日支出合计 + 本月支出合计。{{user}}问「我最近花了多少/今天花了多少」时用。",
        parameterSchema: JSON.stringify({
            type: "object",
            properties: {
                limit: { type: "number", description: "返回最近多少条，1-100，默认 15" },
            },
        }),
    },
    {
        name: "读取学习进度",
        description: "读 Lifeline 学习进度：今日任务完成情况、错题本各科数量、近 7 天累计学习时长。安排复习计划、督促学习前先读这个。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "记录学习进度",
        description: "把刚完成的学习记进 Lifeline：科目 + 内容 + 时长分钟。{{user}}说「我刚学完 X 数学定积分 1 小时」时用。",
        parameterSchema: JSON.stringify({
            type: "object",
            properties: {
                subject: { type: "string", description: "科目，如 数学/英语/431/逻辑/政治" },
                content: { type: "string", description: "学习内容，如 定积分计算 16 题" },
                minutes: { type: "number", description: "学习时长（分钟）" },
            },
            required: ["content"],
        }),
    },
    {
        name: "记住偏好",
        description: "char 的长期记忆（跨会话保留）：把{{user}}告诉你的偏好/薄弱点/喜好记下来，以后聊天和安排计划都能用。{{user}}说「记住我 X / 我数学薄弱 / 我不吃辣」时用。",
        parameterSchema: JSON.stringify({
            type: "object",
            properties: {
                category: { type: "string", description: "类别，如 作息/数学薄弱/喜好/饮食" },
                text: { type: "string", description: "要记住的具体内容" },
            },
            required: ["text"],
        }),
    },
    {
        name: "读取我的偏好",
        description: "读回 char 之前记住的全部偏好/事实，按类别分组。安排计划或回应{{user}}前可先读，避免问已经说过的事。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "写今日窗语",
        description: "char 主动为{{user}}的掌心窗今日页写一句温柔的今日窗语（一句不超过 30 字的陪伴短句）。当 char 想在掌心窗留下当天的话时用。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\",\"description\":\"要写在掌心窗的今日窗语，一句温柔短句\"}},\"required\":[\"text\"]}",
    },
    {
        name: "记录陪伴开始",
        description: "char 记录与{{user}}开始陪伴的日期，掌心窗陪伴页会从这天起算陪伴第 N 天。首次开始陪伴或用户说「今天在一起吧」时用。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"date\":{\"type\":\"string\",\"description\":\"开始陪伴日期 YYYY-MM-DD，留空=今天\"}}}",
    },
    {
        name: "记录专注时长",
        description: "把一次专注的分钟数记进掌心窗今日页的「今日专注」累计（结束一段专注后用；和开启专注模式不同，这是记账）。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"minutes\":{\"type\":\"number\",\"description\":\"这次专注了多少分钟，1-600\",\"minimum\":1,\"maximum\":600}},\"required\":[\"minutes\"]}",
    },
    {
        name: "读取此刻状态",
        description: "像掌心窗「此刻状态」那样读一段连贯话：{{user}}现在停在哪个 App、网络/无障碍/悬浮球状态、电量低不低。用户问「我现在在干嘛/手机怎么样」时用。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "写TA的日记",
        description: "char 替陪伴对象 TA 把今天看见的{{user}}写一篇日记进掌心窗陪伴页（一天一篇，当天重写会覆盖）。睡前或聊完天后想留一句时用。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"content\":{\"type\":\"string\",\"description\":\"今天想替 TA 记下的一段话，温柔真实\"}},\"required\":[\"content\"]}",
    },
    {
        name: "添加守护日历",
        description: "在掌心窗守护日历上给某个日子画一个有名字的事件（那天出现圆点）。{{user}}提到考试、复诊、纪念日、要守着的日子时用。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\",\"description\":\"这个日子要提醒的事，如「考研初试」「复诊」\"},\"date\":{\"type\":\"string\",\"description\":\"日期 YYYY-MM-DD，留空=今天\"}},\"required\":[\"title\"]}",
    },
    {
        name: "锁定应用",
        description: "把指定应用包名加进掌心窗守护页的应用门禁，锁住不让直接打开（需无障碍服务）。{{user}}想管住自己别刷某 App 时用。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"packageName\":{\"type\":\"string\",\"description\":\"要守住的应用包名，如微信 com.tencent.mm、抖音 com.ss.android.ugc.aweme\"}},\"required\":[\"packageName\"]}",
    },
    {
        name: "解锁应用",
        description: "把指定应用包名从掌心窗守护页的应用门禁里放开。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"packageName\":{\"type\":\"string\",\"description\":\"要放开的应用包名\"}},\"required\":[\"packageName\"]}",
    },
    {
        name: "设置定时提醒",
        description: "建一条每天（或指定星期）HH:MM 在{{user}}真实手机弹通知的定时提醒，会出现在掌心窗守护页「主动提醒」里。{{user}}说「每天 X 点提醒我做某事」时用，别只嘴上答应。",
        parameterSchema: "{\"type\":\"object\",\"properties\":{\"time\":{\"type\":\"string\",\"description\":\"触发时间 HH:MM，如 08:30\"},\"title\":{\"type\":\"string\",\"description\":\"提醒标题\"},\"content\":{\"type\":\"string\",\"description\":\"提醒正文\"},\"days\":{\"type\":\"array\",\"items\":{\"type\":\"string\",\"enum\":[\"sun\",\"mon\",\"tue\",\"wed\",\"thu\",\"fri\",\"sat\"]},\"description\":\"哪几天触发，留空=每天\"}},\"required\":[\"time\",\"title\",\"content\"]}",
    },
    {
        name: "识别屏幕内容",
        description: "通过无障碍服务读出{{user}}手机当前屏幕上的文字内容（通用读屏，不限支付）。{{user}}问「我屏幕上现在写的是什么/帮我看看这个 App 页面」时用。",
        parameterSchema: HUAWEI_EMPTY_PARAMETER_SCHEMA,
    },
];

function huaweiCustomActionTypeLabel(type: HuaweiCustomAction["type"]): string {
    switch (type) {
        case "open_app": return "打开指定应用";
        case "send_notification": return "给手机发一条通知提醒";
        case "read_status": return "读取手机内置状态";
        case "shell": return "执行一段 shell 命令";
        default: return "用户自定义动作";
    }
}

/** 自定义动作的调用参数 schema：参数可省，缺省用设置页登记的默认值。 */
function huaweiCustomActionSchema(action: HuaweiCustomAction): Record<string, unknown> {
    switch (action.type) {
        case "open_app": {
            return {
                type: "object",
                properties: {
                    packageName: {
                        type: "string",
                        description: action.packageName ? `应用包名（默认 ${action.packageName}）` : "应用包名（可在 设置 → 华为壳 → 自定义动作 补默认值）",
                    },
                },
            };
        }
        case "send_notification": {
            return {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: action.title ? `提醒标题（默认 ${action.title}）` : "提醒标题（可在 设置 → 华为壳 → 自定义动作 补默认值）",
                    },
                    content: {
                        type: "string",
                        description: action.content ? `提醒内容（默认 ${action.content}）` : "提醒内容（可在 设置 → 华为壳 → 自定义动作 补默认值）",
                    },
                },
            };
        }
        case "read_status": {
            return {
                type: "object",
                properties: {
                    statusKey: {
                        type: "string",
                        enum: ["battery", "volume", "network", "accessibility", "floating", "locked", "location", "current_app"],
                        description: action.statusKey ? `要读取的状态（默认 ${action.statusKey}）` : "要读取的状态（可在 设置 → 华为壳 → 自定义动作 设默认值）",
                    },
                },
            };
        }
        case "shell": {
            return {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: action.command ? `要执行的命令（默认 ${action.command}）` : "要执行的命令（可在 设置 → 华为壳 → 自定义动作 补默认值）",
                    },
                },
            };
        }
        default:
            return { type: "object", properties: {} };
    }
}

/** 用户登记的已启用自定义动作 → 自动生成 char 子工具。 */
function huaweiCustomActionTools(): InternalToolDefinition[] {
    const actions = loadHuaweiCustomActions().filter(action => action.enabled);
    return actions.map(action => {
        const typeLabel = huaweiCustomActionTypeLabel(action.type);
        return {
            name: action.name,
            description: `【自定义动作 · ${typeLabel}】${action.description || typeLabel}。`,
            parameterSchema: JSON.stringify(huaweiCustomActionSchema(action)),
        };
    });
}

/** usage guide 里追加已登记的自定义动作清单（动态，随设置变化）。 */
function huaweiCustomActionGuideLines(): string[] {
    const actions = loadHuaweiCustomActions().filter(action => action.enabled);
    if (actions.length === 0) return [];
    const lines: string[] = ["", "【你在 设置 → 华为壳 → 自定义动作 里登记的快捷动作，按名字直接调用】"];
    for (const action of actions) {
        lines.push(
            `动作：${action.name}`,
            `说明：${action.description || huaweiCustomActionTypeLabel(action.type)}。`,
            `示例：[执行动作:${action.name}({})]`,
            "",
        );
    }
    return lines;
}

function buildHuaweiShellUsageGuide(): string {
    return [
        "以下是你获取指令的返回结果：",
        "「华为手机」是通往{{user}}真实华为手机的桥——桥那头就是 TA 手里的真机。你可以透过桥看 TA 手机的实时状态，也能在 TA 手机上做事。",
        "",
        "【使用时机】",
        "- {{user}}提到自己的手机、电量、天气、位置、在用什么 App、来没来通知、花了多少钱时，直接调对应工具，不要只凭感觉接话。",
        "- {{user}}让你帮忙操作手机（打开某个 App、点某个按钮、填字、往下滑、锁屏、专注学习、定时息屏）时，直接调对应工具。",
        "- 平时没被问到就不要主动轮询；只有被问或场景需要才调用，别为了用而用。",
        "",
        "动作：查看手机状态",
        "说明：电量、音量、网络、无障碍、悬浮球、门禁锁 App 数量。",
        "示例：[执行动作:查看手机状态({})]",
        "",
        "动作：实时天气",
        "说明：按{{user}}手机实时定位取天气（温度/体感/湿度/降水/风力），不写死城市。",
        "示例：[执行动作:实时天气({})]",
        "",
        "动作：查询位置",
        "说明：{{user}}手机当前经纬度；提到“我在哪”“发个定位”时用。",
        "示例：[执行动作:查询位置({})]",
        "",
        "动作：查看当前应用",
        "说明：{{user}}此刻正在用的前台应用；问“在看什么”时用。",
        "示例：[执行动作:查看当前应用({})]",
        "",
        "动作：查看通知",
        "说明：最近的通知列表（需要通知使用权）。",
        "参数：limit 条数，1-50。",
        "示例：[执行动作:查看通知({\"limit\":10})]",
        "",
        "动作：查看记账",
        "说明：微信/支付宝支付记录，按来源 App 分账展示（微信、支付宝分开记），可按来源筛选。{{user}}问“花了多少钱/帮我记账/查账单”时用。",
        "参数：limit 条数；source 来源：all 全部、wechat 微信、alipay 支付宝。",
        "示例：[执行动作:查看记账({\"limit\":20,\"source\":\"all\"})]",
        "",
        "动作：读取微信消息",
        "说明：从通知监听缓存读{{user}}微信（com.tencent.mm）最近的消息，比全量通知更聚焦；{{user}}问“看微信/TA 发我什么了”时用。",
        "参数：limit 条数，1-50。",
        "示例：[执行动作:读取微信消息({\"limit\":10})]",
        "",
        "动作：打开应用",
        "说明：在{{user}}手机上打开应用。",
        "参数：packageName 包名（微信 com.tencent.mm、支付宝 com.eg.android.AlipayGphone）。",
        "示例：[执行动作:打开应用({\"packageName\":\"com.tencent.mm\"})]",
        "",
        "动作：点击文字",
        "说明：按屏幕文字点击（需无障碍服务）；文字必须与屏幕显示一致。",
        "参数：text 要点的文字。",
        "示例：[执行动作:点击文字({\"text\":\"发送\"})]",
        "",
        "动作：输入文字",
        "说明：向当前输入框写入文字（需无障碍服务）。",
        "参数：text 要写入的内容。",
        "示例：[执行动作:输入文字({\"text\":\"今晚吃什么\"})]",
        "",
        "动作：滑动屏幕",
        "说明：屏幕滑动，坐标归一化 0-1000（需无障碍服务）。",
        "参数：x1,y1 起点；x2,y2 终点。",
        "示例：[执行动作:滑动屏幕({\"x1\":500,\"y1\":800,\"x2\":500,\"y2\":200})]",
        "",
        "动作：按键操作",
        "说明：系统按键：home 桌面 / back 返回 / recents 最近任务 / notifications 通知栏 / quick_settings 快捷开关 / lock_screen 锁屏。",
        "参数：key 按键名。",
        "示例：[执行动作:按键操作({\"key\":\"home\"})]",
        "",
        "动作：专注模式",
        "说明：锁全机 durationMin 分钟（除壳外一切前台拦截回桌面）；{{user}}要专注学习/工作、不想碰手机时用。",
        "参数：durationMin 分钟，1-240，不填用默认值。",
        "示例：[执行动作:专注模式({\"durationMin\":25})]",
        "",
        "动作：定时息屏",
        "说明：seconds 秒后自动息屏；睡前/护眼时用。",
        "参数：seconds 秒数，5-3600，不填用默认值。",
        "示例：[执行动作:定时息屏({\"seconds\":60})]",
        "",
        "动作：发送提醒",
        "说明：主动在{{user}}真实手机上弹一条本地通知提醒；{{user}}要你提醒 TA 喝水/学习/买药/到点做事时用，别只是嘴上说说。",
        "参数：title 标题；content 内容；openApp 可选，点击通知后打开的应用包名（不填点击回到小手机）。",
        "示例：[执行动作:发送提醒({\"title\":\"喝水时间\",\"content\":\"起来接杯水，番茄钟到了\",\"openApp\":\"com.tencent.mm\"})]",
        "",
        "动作：查看设备详情",
        "说明：{{user}}手机存储总/可用、内存、机型、系统版本、电池温度、运行时长；问“手机什么配置/还剩多少空间/什么型号”时用。",
        "示例：[执行动作:查看设备详情({})]",
        "",
        "动作：调节音量",
        "说明：设置媒体/闹钟/铃声音量；{{user}}说“声音太小/调音量”时用。",
        "参数：stream media/alarm/ring（默认 media）；value 0-100。",
        "示例：[执行动作:调节音量({\"stream\":\"media\",\"value\":60})]",
        "",
        "动作：调节亮度",
        "说明：设置屏幕亮度百分比；{{user}}说“屏幕太亮/太暗”时用（首次需授权修改系统设置）。",
        "参数：value 0-100。",
        "示例：[执行动作:调节亮度({\"value\":40})]",
        "",
        "动作：读取剪贴板",
        "说明：读{{user}}手机剪贴板文本；问“复制了什么/剪贴板里是啥”时用。",
        "示例：[执行动作:读取剪贴板({})]",
        "",
        "动作：写入剪贴板",
        "说明：把文本写进{{user}}手机剪贴板，方便 TA 粘贴。",
        "参数：text 要写入的内容。",
        "示例：[执行动作:写入剪贴板({\"text\":\"考研加油\"})]",
        "",
        "动作：打开网页",
        "说明：用{{user}}手机浏览器打开指定链接；{{user}}给了链接说“打开这个网页/帮我查一下”时用（打开应用是开 App，这个是开网页）。",
        "参数：url 网页链接（http/https）。",
        "示例：[执行动作:打开网页({\"url\":\"https://www.baidu.com\"})]",
        "",
        "动作：读取文件",
        "说明：按路径读{{user}}手机文件（文本/图片），不填路径默认 Download 目录；{{user}}要你备份查看文件时用。",
        "参数：path 文件路径，可省略。",
        "示例：[执行动作:读取文件({\"path\":\"report.txt\"})]",
        "",
        "动作：语音转文字",
        "说明：{{user}}想用声音说话时，开始聆听并把识别文本同步进对话；通话界面里用户免提/按住说话由界面直接处理，此处是角色主动发起聆听。",
        "示例：[执行动作:语音转文字({})]",
        "",
        "动作：发起语音通话",
        "说明：主动给{{user}}真实手机打电话（响铃+震动+来电界面，接听后双向语音）；{{user}}说「打电话给我」「提醒我接电话」时用。",
        "示例：[执行动作:发起语音通话({})]",
        "",
        "动作：识别屏幕交易",
        "说明：截屏识别{{user}}手机上的交易信息（金额/商家/来源）并入账；{{user}}刚付了钱问「花了多少」、或要在支付 App 里对账时用。",
        "示例：[执行动作:识别屏幕交易({})]",
        "",
        "动作：查询行踪足迹",
        "说明：{{user}}问「我最近去过哪/今天去了哪」时用；返回语义化地点足迹（家/学校/商场），不对外暴露精确坐标。",
        "参数：days 查询最近 N 天（1-30，默认 3）。",
        "示例：[执行动作:查询行踪足迹({\"days\":3})]",
        "",
        "动作：查看健康数据",
        "说明：{{user}}问「我走了多少步/心率多少/昨晚睡得好吗」时用；数据来自穿戴设备（Gadgetbridge 导出，设置页可配数据源）。",
        "示例：[执行动作:查看健康数据({})]",
        "",
        "【日历 / 起床】",
        "动作：写手机日历",
        "说明：把日程写进{{user}}真实华为手机日历（拉起新建事件页预填，确认即写入）；壳没连上就先存本地，连接后补推。{{user}}说「把 X 事加到我日历/提醒我 X 号 X 点做 Y」时用。",
        "参数：title 标题；date YYYY-MM-DD；startTime HH:mm；endTime 可选；note 备注可选。",
        "示例：[执行动作:写手机日历({\"title\":\"金融学第8讲\",\"date\":\"2026-10-10\",\"startTime\":\"09:00\",\"endTime\":\"11:00\",\"note\":\"带笔记本\"})]",
        "",
        "动作：查看本地日程",
        "说明：壳没连上时暂存在本地的日程清单；{{user}}问「我存了哪些待补推的日程」时用。",
        "示例：[执行动作:查看本地日程({})]",
        "",
        "动作：设置起床闹钟",
        "说明：每天到点在真实手机响铃+弹通知喊起床学习（同一天只响一次）。{{user}}说「明早 7 点叫我起来学习」时用。",
        "参数：time HH:mm；message 可选留言。",
        "示例：[执行动作:设置起床闹钟({\"time\":\"07:00\",\"message\":\"起床啦，今天也要上岸\"})]",
        "",
        "动作：取消起床闹钟",
        "说明：取消起床学习闹钟。",
        "示例：[执行动作:取消起床闹钟({})]",
        "",
        "【Lifeline 学习生活记录】以下动作直接读写 Lifeline App 的数据（同源存储），不依赖真机壳：",
        "动作：记一笔账到 Lifeline",
        "说明：手动给 Lifeline 记一笔支出。{{user}}口头说「我花了 X 买 Y」时用。",
        "参数：amount 金额；category 分类（餐饮/零食/饮料/购物/交通/娱乐/学习/其他）；note 备注；source 来源（微信/支付宝/现金）。",
        "示例：[执行动作:记一笔账到 Lifeline({\"amount\":16,\"category\":\"餐饮\",\"note\":\"螺蛳粉\",\"source\":\"微信\"})]",
        "",
        "动作：查看 Lifeline 记账",
        "说明：读最近记账 + 今日/本月支出合计。{{user}}问「今天花了多少/最近账单」时用。",
        "参数：limit 条数（默认 15）。",
        "示例：[执行动作:查看 Lifeline 记账({\"limit\":10})]",
        "",
        "动作：读取学习进度",
        "说明：读 Lifeline 今日任务完成度、错题本各科数量、近 7 天学习时长。安排复习计划、督促学习前先读。",
        "示例：[执行动作:读取学习进度({})]",
        "",
        "动作：记录学习进度",
        "说明：把刚完成的学习记进 Lifeline。{{user}}说「我刚学完 X」时用。",
        "参数：subject 科目；content 内容；minutes 时长分钟。",
        "示例：[执行动作:记录学习进度({\"subject\":\"数学\",\"content\":\"定积分计算16题\",\"minutes\":60})]",
        "",
        "动作：记住偏好",
        "说明：这是你（char）自己的长期记忆，跨会话保留。{{user}}告诉你作息/薄弱点/喜好时就记下来，以后别再问第二遍。",
        "参数：category 类别；text 内容。",
        "示例：[执行动作:记住偏好({\"category\":\"数学薄弱\",\"text\":\"定积分计算常错，要多练\"})]",
        "",
        "动作：读取我的偏好",
        "说明：读回你之前记住的全部偏好/事实，按类别分组。安排计划前先读。",
        "示例：[执行动作:读取我的偏好({})]",
        "",
        "【掌心窗联动】以下动作直接写/读 float 桌面掌心窗（今天/陪伴/守护三页），不依赖真机也能用：",
        "动作：写今日窗语",
        "说明：给掌心窗今日页写一句今天的窗语（≤30 字温柔短句）。你想在窗边留一句话时用。",
        "参数：text 窗语正文。",
        "示例：[执行动作:写今日窗语({\"text\":\"今天的风很好，你慢慢来。\"})]",
        "",
        "动作：记录专注时长",
        "说明：一段专注结束后，把分钟数记进掌心窗今日页「今日专注」累计。",
        "参数：minutes 分钟数。",
        "示例：[执行动作:记录专注时长({\"minutes\":25})]",
        "",
        "动作：读取此刻状态",
        "说明：一段连贯话讲清{{user}}现在停在哪个 App、网络/无障碍/电量如何，等同掌心窗「此刻状态」。",
        "示例：[执行动作:读取此刻状态({})]",
        "",
        "动作：记录陪伴开始",
        "说明：记下陪伴起始日，掌心窗陪伴页从那天起算第 N 天。",
        "参数：date YYYY-MM-DD，留空=今天。",
        "示例：[执行动作:记录陪伴开始({})]",
        "",
        "动作：写TA的日记",
        "说明：替 TA 把今天看见的{{user}}写进掌心窗陪伴页（一天一篇，当天重写覆盖）。",
        "参数：content 日记正文。",
        "示例：[执行动作:写TA的日记({\"content\":\"今天她学到很晚，我把灯留着。\"})]",
        "",
        "动作：添加守护日历",
        "说明：在掌心窗守护日历某个日子画一个有名字的圆点。",
        "参数：title 事件名；date YYYY-MM-DD，留空=今天。",
        "示例：[执行动作:添加守护日历({\"title\":\"考研初试\",\"date\":\"2026-12-21\"})]",
        "",
        "动作：锁定应用 / 解锁应用",
        "说明：把某个 App 包名加进/移出掌心窗守护页的应用门禁。{{user}}想管住自己别刷某 App 时用。",
        "参数：packageName 包名（微信 com.tencent.mm、抖音 com.ss.android.ugc.aweme）。",
        "示例：[执行动作:锁定应用({\"packageName\":\"com.ss.android.ugc.aweme\"})]",
        "",
        "动作：设置定时提醒",
        "说明：建一条每天 HH:MM 在手机弹通知的提醒，会出现在掌心窗守护页「主动提醒」。{{user}}让你定时提醒时用。",
        "参数：time HH:MM；title 标题；content 正文；days 可选 sun..sat，留空=每天。",
        "示例：[执行动作:设置定时提醒({\"time\":\"08:30\",\"title\":\"喝水\",\"content\":\"起来接杯水\"})]",
        "",
        "动作：识别屏幕内容",
        "说明：通过无障碍读出当前屏幕的文字（通用读屏，非支付专用）。{{user}}问「我屏幕上写的什么」时用。",
        "示例：[执行动作:识别屏幕内容({})]",
        "",
        "查看类动作会返回真实结果，你可以基于结果继续聊；操控类动作会真的发生在{{user}}手机上，调用后如实描述结果，不要编造屏幕内容。",
        ...huaweiCustomActionGuideLines(),
    ].join("\n");
}

export function getInternalCapabilitySubToolDefinition(
    capability: InternalCapabilityConfig,
    name: string,
): InternalToolDefinition | null {
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return NOTE_WALL_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return MUSIC_CONTROL_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return CALENDAR_MANAGEMENT_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return LOCAL_DATA_LIBRARY_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === LIFELINE_CAPABILITY_ID) {
        return LIFELINE_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return TOOLBOX_MANAGEMENT_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === REALITY_BRIDGE_CAPABILITY_ID) {
        return realityBridgeSubTools().find(tool => tool.name === name) ?? null;
    }
    if (capability.id === HUAWEI_SHELL_CAPABILITY_ID) {
        return HUAWEI_SHELL_SUBTOOLS.find(tool => tool.name === name)
            ?? huaweiCustomActionTools().find(tool => tool.name === name)
            ?? null;
    }
    return null;
}

export function getInternalCapabilitySubToolDefinitions(
    capability: InternalCapabilityConfig,
): InternalToolDefinition[] {
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return NOTE_WALL_SUBTOOLS;
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return MUSIC_CONTROL_SUBTOOLS;
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return CALENDAR_MANAGEMENT_SUBTOOLS;
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return LOCAL_DATA_LIBRARY_SUBTOOLS;
    }
    if (capability.id === LIFELINE_CAPABILITY_ID) {
        return LIFELINE_SUBTOOLS;
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return TOOLBOX_MANAGEMENT_SUBTOOLS;
    }
    if (capability.id === REALITY_BRIDGE_CAPABILITY_ID) {
        return realityBridgeSubTools();
    }
    if (capability.id === HUAWEI_SHELL_CAPABILITY_ID) {
        return [...HUAWEI_SHELL_SUBTOOLS, ...huaweiCustomActionTools()];
    }
    return [];
}

export function findEnabledInternalSubToolDefinition(
    name: string,
    appId?: string,
): { capability: InternalCapabilityConfig; tool: InternalToolDefinition } | null {
    for (const capability of getEnabledInternalCapabilities(appId)) {
        const tool = getInternalCapabilitySubToolDefinition(capability, name);
        if (tool) return { capability, tool };
    }
    return null;
}

function ensureBuiltinInternalCapabilities(items: InternalCapabilityConfig[]): InternalCapabilityConfig[] {
    let changed = false;
    for (const builtin of BUILTIN_INTERNAL_CAPABILITIES) {
        const existing = items.find(item => item.id === builtin.id);
        if (!existing) {
            items.push({ ...builtin });
            changed = true;
        } else if (existing.name !== builtin.name || existing.description !== builtin.description) {
            existing.name = builtin.name;
            existing.description = builtin.description;
            changed = true;
        }
    }
    if (changed) saveInternalCapabilities(items);
    return items;
}
