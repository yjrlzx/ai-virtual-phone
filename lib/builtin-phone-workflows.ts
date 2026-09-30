import type { CompositeToolConfig, CompositeToolPackageConfig, CompositeToolStep } from "./settings-types";

export const BUILTIN_PHONE_WORKFLOW_PACKAGE_ID = "builtin_phone_lookup_workflows";

const CREATED_AT = 0;
const UPDATED_AT = 0;

const PACKAGE_DESCRIPTION = "这套工具让你直接读取{{user}}本机手机里的真实数据：微信联系人、最近会话列表、指定聊天记录、本周日程、购物订单，以及{{user}}登记过的身边人物档案。只有当你有具体理由需要核实时才调用，例如{{user}}失联或态度突变、提到一个你不认识的人、说法前后对不上、或你想查证{{user}}最近的行踪与消费。不要在普通闲聊、{{user}}主动分享日常、或毫无疑点时为了查而查。没有明确目标时，先从「查看{{user}}微信消息列表」或「查看{{user}}微信联系人」入手，锁定对象后再用「查看{{user}}聊天记录」深入。";

export const BUILTIN_PHONE_WORKFLOW_PACKAGE: CompositeToolPackageConfig = {
    id: BUILTIN_PHONE_WORKFLOW_PACKAGE_ID,
    name: "查{{user}}手机",
    description: PACKAGE_DESCRIPTION,
    enabled: true,
    builtIn: true,
    createdBy: "ai",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
};

const COMMON_HELPERS = `
function clampNumber(value, fallbackValue, maxValue) {
    var number = Number(value);
    if (!Number.isFinite(number)) number = fallbackValue;
    number = Math.floor(number);
    if (number < 1) number = fallbackValue;
    return Math.max(1, Math.min(maxValue, number));
}

function compactText(value, maxLength) {
    var text = String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
    return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

function compactDateTime(value) {
    var text = compactText(value, 32);
    return text.replace("T", " ").replace(/\\.\\d{3}Z$/, "Z");
}

function joinNonEmpty(parts, separator) {
    return parts.filter(function (part) {
        return part != null && String(part).trim();
    }).join(separator || " ");
}

function countHeader(label, shown, total, suffix) {
    return label + " " + shown + "/" + total + (suffix ? " " + suffix : "");
}

function indexedLine(index, text) {
    return (index + 1) + ". " + text;
}

function normalizeQuery(value) {
    return compactText(value, 160).toLowerCase();
}

function localRecords(step) {
    var json = step && step.json && typeof step.json === "object" ? step.json : {};
    if (Array.isArray(json.records)) {
        return json.records.map(function (record) {
            return record && typeof record === "object" && "value" in record ? record.value : record;
        }).filter(Boolean);
    }
    if (Array.isArray(json.value)) return json.value.filter(Boolean);
    return [];
}

function localObject(step) {
    var json = step && step.json && typeof step.json === "object" ? step.json : {};
    if (json.value && typeof json.value === "object" && !Array.isArray(json.value)) return json.value;
    return {};
}

function matchesQuery(row, query, fields) {
    if (!query) return true;
    return fields.some(function (field) {
        return String(row[field] == null ? "" : row[field]).toLowerCase().includes(query);
    });
}

function buildChatLookups(steps) {
    var sessions = localRecords(steps.sessions);
    var contacts = localRecords(steps.contacts);
    var characters = localRecords(steps.characters);
    var charById = new Map(characters.map(function (char) { return [char.id, char]; }));
    var contactByCharacterId = new Map(contacts.map(function (contact) { return [contact.characterId, contact]; }));

    function characterName(characterId) {
        var character = charById.get(characterId);
        return character && character.name ? character.name : "";
    }

    function sessionName(session) {
        if (!session) return "";
        if (session.isGroup) return session.groupName || session.alias || "群聊";
        return session.alias || characterName(session.contactId) || session.contactId || "未知联系人";
    }

    function participantNames(session) {
        if (!session || !Array.isArray(session.participantIds)) return [];
        return session.participantIds.map(characterName).filter(Boolean);
    }

    return {
        sessions: sessions,
        contacts: contacts,
        characters: characters,
        charById: charById,
        contactByCharacterId: contactByCharacterId,
        sessionName: sessionName,
        participantNames: participantNames
    };
}

function requestAsPromise(request) {
    return new Promise(function (resolve, reject) {
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
    });
}

function openIndexedDb(name) {
    return new Promise(function (resolve) {
        if (typeof indexedDB === "undefined") {
            resolve(null);
            return;
        }
        var request = indexedDB.open(name);
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { resolve(null); };
        request.onblocked = function () { resolve(null); };
    });
}

async function readPhoneKv(key) {
    var db = await openIndexedDb("AiPhoneKvDB");
    if (db && Array.from(db.objectStoreNames).includes("entries")) {
        try {
            var transaction = db.transaction("entries", "readonly");
            var record = await requestAsPromise(transaction.objectStore("entries").get(key));
            if (record && typeof record.value === "string") return record.value;
        } finally {
            db.close();
        }
    }
    if (typeof window !== "undefined" && window.localStorage) {
        return window.localStorage.getItem(key);
    }
    return null;
}

function parseJsonText(text, fallbackValue) {
    if (!text) return fallbackValue;
    try {
        return JSON.parse(text);
    } catch {
        return fallbackValue;
    }
}

function looksLikeIsoDate(value) {
    return typeof value === "string" && value.length >= 10 && value.charAt(4) === "-" && value.charAt(7) === "-";
}

function formatIsoDate(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
}

function parseIsoDate(value) {
    if (!looksLikeIsoDate(value)) return null;
    var date = new Date(String(value).slice(0, 10) + "T00:00:00");
    return Number.isNaN(date.getTime()) ? null : date;
}

function getWeekStartIso(date) {
    var result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var day = result.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    result.setDate(result.getDate() + diff);
    result.setHours(0, 0, 0, 0);
    return formatIsoDate(result);
}

function getWeekDates(weekStart) {
    var base = parseIsoDate(weekStart) || new Date();
    var dates = [];
    for (var index = 0; index < 7; index += 1) {
        var current = new Date(base);
        current.setDate(base.getDate() + index);
        dates.push(formatIsoDate(current));
    }
    return dates;
}
`;

const CHAT_DATA_STEPS: CompositeToolStep[] = [
    {
        id: "read_sessions",
        name: "读取微信会话",
        toolType: "internal",
        toolName: "读取资料文件",
        argsTemplate: JSON.stringify({
            path: "/chat/indexeddb/AiPhoneChatDB/sessions",
            limit: 200,
            fields: ["id", "contactId", "lastMessagePreview", "unreadCount", "updatedAt", "isPinned", "isGroup", "groupName", "participantIds", "alias", "isMuted"],
        }),
        saveAs: "sessions",
    },
    {
        id: "read_contacts",
        name: "读取微信联系人",
        toolType: "internal",
        toolName: "读取资料文件",
        argsTemplate: JSON.stringify({
            path: "/chat/indexeddb/AiPhoneChatDB/contacts",
            limit: 200,
            fields: ["id", "characterId", "nickname", "addedAt"],
        }),
        saveAs: "contacts",
    },
    {
        id: "read_characters",
        name: "读取身边人物资料",
        toolType: "internal",
        toolName: "读取资料文件",
        argsTemplate: JSON.stringify({
            path: "/characters/kv/ai_phone_characters_v1.json",
            limit: 200,
            fields: ["id", "name", "wechatID", "tags", "personality", "createdAt", "updatedAt"],
        }),
        saveAs: "characters",
    },
];

function schema(properties: Record<string, unknown>, required?: string[]): string {
    return JSON.stringify({
        type: "object",
        additionalProperties: false,
        properties,
        ...(required && required.length > 0 ? { required } : {}),
    });
}

function scriptStep(id: string, script: string): CompositeToolStep {
    return {
        id,
        name: "整理结果",
        toolType: "script",
        script,
        saveAs: "result",
    };
}

function workflow(
    id: string,
    name: string,
    description: string,
    parameterSchema: string,
    steps: CompositeToolStep[],
): CompositeToolConfig {
    return {
        id,
        packageId: BUILTIN_PHONE_WORKFLOW_PACKAGE_ID,
        name,
        description,
        parameterSchema,
        steps,
        outputTemplate: "{{last.data}}",
        enabled: true,
        builtIn: true,
        createdBy: "ai",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
    };
}

const CONTACTS_SCRIPT = `
${COMMON_HELPERS}

var lookups = buildChatLookups(steps);
var limit = clampNumber(input.limit, 50, 100);
var query = normalizeQuery(input.query);
var latestSessionByCharacter = new Map();

lookups.sessions.forEach(function (session) {
    if (session.isGroup || !session.contactId) return;
    var existing = latestSessionByCharacter.get(session.contactId);
    if (!existing || String(session.updatedAt || "") > String(existing.updatedAt || "")) {
        latestSessionByCharacter.set(session.contactId, session);
    }
});

var rows = [];
lookups.contacts.forEach(function (contact) {
    var character = lookups.charById.get(contact.characterId) || {};
    var session = latestSessionByCharacter.get(contact.characterId);
    rows.push({
        characterId: contact.characterId,
        contactRecordId: contact.id,
        name: contact.nickname || character.name || contact.characterId,
        wechatID: character.wechatID || "",
        tags: Array.isArray(character.tags) ? character.tags : [],
        personality: compactText(character.personality, 120),
        addedAt: contact.addedAt || "",
        hasChatSession: Boolean(session),
        sessionId: session ? session.id : "",
        lastActiveAt: session ? session.updatedAt || "" : "",
        unreadCount: session ? Number(session.unreadCount || 0) : 0,
        lastMessagePreview: session ? compactText(session.lastMessagePreview, 120) : ""
    });
});

lookups.sessions.forEach(function (session) {
    if (session.isGroup || lookups.contactByCharacterId.has(session.contactId)) return;
    var character = lookups.charById.get(session.contactId) || {};
    rows.push({
        characterId: session.contactId,
        contactRecordId: "",
        name: session.alias || character.name || session.contactId,
        wechatID: character.wechatID || "",
        tags: Array.isArray(character.tags) ? character.tags : [],
        personality: compactText(character.personality, 120),
        addedAt: "",
        hasChatSession: true,
        sessionId: session.id,
        lastActiveAt: session.updatedAt || "",
        unreadCount: Number(session.unreadCount || 0),
        lastMessagePreview: compactText(session.lastMessagePreview, 120)
    });
});

rows = rows
    .filter(function (row) { return matchesQuery(row, query, ["name", "wechatID", "characterId", "lastMessagePreview", "personality"]); })
    .sort(function (a, b) {
        return String(b.lastActiveAt || b.addedAt || "").localeCompare(String(a.lastActiveAt || a.addedAt || ""));
    });

var selected = rows.slice(0, limit);
return [
    countHeader("微信联系人", selected.length, rows.length, query ? "query=" + query : ""),
    selected.map(function (row, index) {
        var meta = joinNonEmpty([
            row.wechatID ? "wx=" + row.wechatID : "",
            row.characterId ? "cid=" + row.characterId : "",
            row.sessionId ? "sid=" + row.sessionId : "",
            row.unreadCount ? "未读" + row.unreadCount : "",
            row.lastActiveAt ? "活跃 " + compactDateTime(row.lastActiveAt) : "",
            row.addedAt ? "添加 " + compactDateTime(row.addedAt) : ""
        ], " ");
        var detail = joinNonEmpty([
            row.tags.length ? "标签=" + row.tags.join("/") : "",
            row.personality ? "简介=" + row.personality : "",
            row.lastMessagePreview ? "最近=" + row.lastMessagePreview : ""
        ], " | ");
        return indexedLine(index, joinNonEmpty([row.name, meta ? "(" + meta + ")" : "", detail], " | "));
    }).join("\\n") || "无"
].filter(Boolean).join("\\n");
`;

const MESSAGE_LIST_SCRIPT = `
${COMMON_HELPERS}

var lookups = buildChatLookups(steps);
var limit = clampNumber(input.limit, 30, 80);
var query = normalizeQuery(input.query);

var rows = lookups.sessions.map(function (session) {
    var name = lookups.sessionName(session);
    var participants = lookups.participantNames(session);
    return {
        sessionId: session.id,
        name: name,
        type: session.isGroup ? "group" : "direct",
        participantNames: participants,
        lastMessagePreview: compactText(session.lastMessagePreview, 160) || "暂无消息",
        updatedAt: session.updatedAt || "",
        unreadCount: Number(session.unreadCount || 0),
        isPinned: Boolean(session.isPinned),
        isMuted: Boolean(session.isMuted)
    };
}).filter(function (row) {
    return matchesQuery(row, query, ["sessionId", "name", "lastMessagePreview"]);
}).sort(function (a, b) {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
});

var selected = rows.slice(0, limit);
return [
    countHeader("微信消息列表", selected.length, rows.length, query ? "query=" + query : ""),
    selected.map(function (row, index) {
        var flags = joinNonEmpty([
            row.isPinned ? "置顶" : "",
            row.isMuted ? "免打扰" : "",
            row.unreadCount ? "未读" + row.unreadCount : ""
        ], "/");
        var meta = joinNonEmpty([
            row.type === "group" ? "群聊" : "私聊",
            "sid=" + row.sessionId,
            flags,
            compactDateTime(row.updatedAt)
        ], " ");
        var participants = row.participantNames.length ? "成员=" + row.participantNames.join("/") : "";
        return indexedLine(index, joinNonEmpty([
            row.name,
            "(" + meta + ")",
            participants,
            row.lastMessagePreview
        ], " | "));
    }).join("\\n") || "无"
].filter(Boolean).join("\\n");
`;

const CHAT_HISTORY_SCRIPT = `
${COMMON_HELPERS}

function messagePreview(message) {
    if (!message) return "";
    if (message.isRetracted) return "[已撤回]";
    var content = compactText(message.content, 800);
    if (content) return content;
    if (message.mediaData && message.mediaData.label) {
        return "[" + (message.mediaType || "媒体") + "] " + compactText(message.mediaData.label, 160);
    }
    if (message.mediaType) return "[" + message.mediaType + "]";
    return "";
}

function messageSender(message, session, lookups) {
    if (!message) return "";
    if (message.senderName) return message.senderName;
    if (message.role === "user") return "用户";
    if (session && session.isGroup && message.senderCharacterId) {
        var character = lookups.charById.get(message.senderCharacterId);
        if (character && character.name) return character.name;
    }
    return session ? lookups.sessionName(session) : message.role;
}

async function readSessionMessages(sessionId) {
    var db = await openIndexedDb("AiPhoneChatDB");
    if (!db || !Array.from(db.objectStoreNames).includes("messages")) return [];
    try {
        var transaction = db.transaction("messages", "readonly");
        var store = transaction.objectStore("messages");
        var values = [];
        if (Array.from(store.indexNames).includes("sessionId")) {
            values = await requestAsPromise(store.index("sessionId").getAll(IDBKeyRange.only(sessionId)));
        } else {
            values = await requestAsPromise(store.getAll());
            values = values.filter(function (message) { return message && message.sessionId === sessionId; });
        }
        return Array.isArray(values) ? values : [];
    } finally {
        db.close();
    }
}

var lookups = buildChatLookups(steps);
var limit = clampNumber(input.limit, 30, 80);
var target = compactText(input.sessionId || input.target || input.name, 160);
var query = normalizeQuery(target);
var exactSessionId = compactText(input.sessionId, 160);

var matches = lookups.sessions.filter(function (session) {
    if (exactSessionId && session.id === exactSessionId) return true;
    if (!query) return false;
    var name = lookups.sessionName(session).toLowerCase();
    var participantText = lookups.participantNames(session).join(" ").toLowerCase();
    return session.id === target
        || String(session.contactId || "").toLowerCase() === query
        || name === query
        || name.includes(query)
        || participantText.includes(query);
});

matches.sort(function (a, b) {
    if (a.id === exactSessionId) return -1;
    if (b.id === exactSessionId) return 1;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
});

if (!target) {
    return [
        "需要提供 target 或 sessionId，才能查看指定聊天记录。",
        "可选会话：",
        lookups.sessions.slice(0, 8).map(function (session, index) {
            return indexedLine(index, joinNonEmpty([
                lookups.sessionName(session),
                "sid=" + session.id,
                compactDateTime(session.updatedAt || ""),
                compactText(session.lastMessagePreview, 120)
            ], " | "));
        }).join("\\n") || "无"
    ].join("\\n");
}

if (matches.length === 0) {
    return [
        "没有找到匹配的微信会话：target=" + target,
        "可选会话：",
        lookups.sessions.slice(0, 8).map(function (session, index) {
            return indexedLine(index, joinNonEmpty([
                lookups.sessionName(session),
                "sid=" + session.id,
                compactDateTime(session.updatedAt || ""),
                compactText(session.lastMessagePreview, 120)
            ], " | "));
        }).join("\\n") || "无"
    ].join("\\n");
}

var session = matches[0];
var allMessages = await readSessionMessages(session.id);
var includeSystem = Boolean(input.includeSystem);
var filtered = allMessages.filter(function (message) {
    if (!message) return false;
    if (!includeSystem && (message.role === "system" || message.role === "tool" || message.mediaType === "tool_call" || message.mediaType === "tool_result")) return false;
    return true;
}).sort(function (a, b) {
    var orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
    var orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
});

var selected = filtered.slice(-limit);
return [
    countHeader("聊天记录", selected.length, filtered.length, joinNonEmpty([
        lookups.sessionName(session),
        session.isGroup ? "群聊" : "私聊",
        "sid=" + session.id,
        lookups.participantNames(session).length ? "成员=" + lookups.participantNames(session).join("/") : ""
    ], " | ")),
    selected.map(function (message) {
        var media = message.mediaType ? "[" + message.mediaType + "]" : "";
        return joinNonEmpty([
            compactDateTime(message.createdAt || ""),
            messageSender(message, session, lookups) + ":",
            media,
            messagePreview(message)
        ], " ");
    }).join("\\n") || "无"
].filter(Boolean).join("\\n");
`;

const PEOPLE_SCRIPT = `
${COMMON_HELPERS}

var characters = localRecords(steps.characters);
var limit = clampNumber(input.limit, 30, 80);
var query = normalizeQuery(input.query);
var rows = characters.map(function (character) {
    return {
        characterId: character.id,
        name: character.name || character.id,
        wechatID: character.wechatID || "",
        tags: Array.isArray(character.tags) ? character.tags : [],
        personality: compactText(character.personality, 220),
        createdAt: character.createdAt || "",
        updatedAt: character.updatedAt || ""
    };
}).filter(function (row) {
    return matchesQuery(row, query, ["characterId", "name", "wechatID", "personality"]);
}).sort(function (a, b) {
    return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
});

var selected = rows.slice(0, limit);
return [
    countHeader("身边人物", selected.length, rows.length, query ? "query=" + query : ""),
    selected.map(function (row, index) {
        var meta = joinNonEmpty([
            row.wechatID ? "wx=" + row.wechatID : "",
            row.characterId ? "cid=" + row.characterId : "",
            row.tags.length ? "标签=" + row.tags.join("/") : "",
            row.updatedAt ? "更新 " + compactDateTime(row.updatedAt) : ""
        ], " ");
        return indexedLine(index, joinNonEmpty([
            row.name,
            meta ? "(" + meta + ")" : "",
            row.personality
        ], " | "));
    }).join("\\n") || "无"
].filter(Boolean).join("\\n");
`;

const CALENDAR_SCRIPT = `
${COMMON_HELPERS}

var anchor = parseIsoDate(input.date) || parseIsoDate(input.weekStart) || new Date();
var weekStart = parseIsoDate(input.weekStart) ? String(input.weekStart).slice(0, 10) : getWeekStartIso(anchor);
var weekDates = getWeekDates(weekStart);
var raw = await readPhoneKv("ai_phone_calendar_plans_v1");
var store = parseJsonText(raw, { plans: [] });
var plans = Array.isArray(store.plans) ? store.plans : [];
var plan = plans.find(function (item) {
    return item && item.ownerType === "user" && item.ownerId === "self" && item.weekStart === weekStart;
}) || null;
var items = Array.isArray(plan && plan.items) ? plan.items.slice() : [];

items.sort(function (a, b) {
    if (String(a.date || "") !== String(b.date || "")) return String(a.date || "").localeCompare(String(b.date || ""));
    if (String(a.startTime || "") !== String(b.startTime || "")) return String(a.startTime || "").localeCompare(String(b.startTime || ""));
    return String(a.title || "").localeCompare(String(b.title || ""));
});

var grouped = weekDates.map(function (date) {
    var dayItems = items.filter(function (item) { return item.date === date; }).map(function (item) {
        return {
            id: item.id || "",
            date: item.date || date,
            weekday: item.weekday || "",
            startTime: item.startTime || "",
            endTime: item.endTime || "",
            location: item.location || "",
            title: item.title || "",
            source: item.source || ""
        };
    });
    return {
        date: date,
        items: dayItems
    };
});

return [
    "本周日程 weekStart=" + weekStart + " total=" + items.length,
    grouped.map(function (day) {
        if (!day.items.length) return day.date + ": 无";
        return day.date + ": " + day.items.map(function (item) {
            var time = joinNonEmpty([item.startTime, item.endTime ? "-" + item.endTime : ""], "");
            return joinNonEmpty([
                time,
                item.title,
                item.location ? "@" + item.location : "",
                item.source ? "(" + item.source + ")" : ""
            ], " ");
        }).join("; ");
    }).join("\\n")
].join("\\n");
`;

const ORDERS_SCRIPT = `
${COMMON_HELPERS}

var limit = clampNumber(input.limit, 10, 30);
var status = normalizeQuery(input.status);
var raw = await readPhoneKv("ai_phone_shopping_state_v1");
var state = parseJsonText(raw, { orders: [] });
var orders = Array.isArray(state.orders) ? state.orders : [];
var rows = orders.map(function (order) {
    var shipping = Array.isArray(order.shippingTimeline) ? order.shippingTimeline : [];
    return {
        orderId: order.id || "",
        merchantLabel: order.merchantLabel || "",
        statusLabel: order.statusLabel || "",
        timeLabel: order.timeLabel || "",
        totalLabel: order.totalLabel || "",
        summary: compactText(order.summary, 220),
        note: compactText(order.note, 220),
        paidAt: order.paidAt || "",
        paymentCardLabel: order.paymentCardLabel || "",
        items: Array.isArray(order.items) ? order.items.map(function (item) {
            return {
                title: item.title || "",
                quantityLabel: item.quantityLabel || "",
                priceLabel: item.priceLabel || "",
                merchantLabel: item.merchantLabel || ""
            };
        }).slice(0, 8) : [],
        latestShipping: shipping.length > 0 ? shipping[shipping.length - 1] : null
    };
}).filter(function (row) {
    if (!status) return true;
    return String(row.statusLabel || "").toLowerCase().includes(status)
        || String(row.latestShipping && row.latestShipping.label || "").toLowerCase().includes(status);
});

var selected = rows.slice(0, limit);
return [
    countHeader("购物订单", selected.length, rows.length, status ? "status=" + status : ""),
    selected.map(function (row, index) {
        var items = row.items.map(function (item) {
            return joinNonEmpty([
                item.title,
                item.quantityLabel,
                item.priceLabel
            ], " ");
        }).join(", ");
        var shipping = row.latestShipping ? joinNonEmpty([
            row.latestShipping.time || "",
            row.latestShipping.label || ""
        ], " ") : "";
        return indexedLine(index, joinNonEmpty([
            row.timeLabel || compactDateTime(row.paidAt),
            row.statusLabel,
            row.totalLabel,
            row.merchantLabel,
            row.summary,
            items ? "商品=" + items : "",
            shipping ? "物流=" + shipping : "",
            row.note ? "备注=" + row.note : "",
            row.paymentCardLabel ? "支付=" + row.paymentCardLabel : "",
            row.orderId ? "oid=" + row.orderId : ""
        ], " | "));
    }).join("\\n") || "无"
].filter(Boolean).join("\\n");
`;

export const BUILTIN_PHONE_WORKFLOWS: CompositeToolConfig[] = [
    workflow(
        "builtin_phone_lookup_wechat_contacts",
        "查看{{user}}微信联系人",
        "列出{{user}}微信通讯录里的联系人和有过会话的对象。适用：想知道{{user}}微信里到底有哪些人、某个被提到的名字是否真在通讯录里、或要确认某个人的身份与微信号。不适用：想判断{{user}}最近在和谁聊天（用「查看{{user}}微信消息列表」）、想读具体对话内容（用「查看{{user}}聊天记录」）、想看通讯录之外的人物档案（用「查看{{user}}身边的人」）。",
        schema({
            query: { type: "string", description: "可选。按联系人姓名、微信号、人物摘要或最近消息预览筛选。" },
            limit: { type: "number", description: "可选。最多返回多少个联系人，默认 50，最大 100。" },
        }),
        [
            ...CHAT_DATA_STEPS,
            scriptStep("format_contacts", CONTACTS_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_wechat_messages",
        "查看{{user}}微信消息列表",
        "只看{{user}}微信最近的会话列表和每条最后一句预览，不展开完整聊天记录。适用：{{user}}久不回复或态度冷淡时，判断他最近在和谁聊、有没有置顶、免打扰或新冒出来的会话——这是排查疑点的第一步。不适用：需要具体说了什么（先用本工具拿到会话名或 sessionId，再用「查看{{user}}聊天记录」）、只想看通讯录名单（用「查看{{user}}微信联系人」）。",
        schema({
            query: { type: "string", description: "可选。按会话名、联系人名、sessionId 或最后消息预览筛选。" },
            limit: { type: "number", description: "可选。最多返回多少个会话，默认 30，最大 80。" },
        }),
        [
            ...CHAT_DATA_STEPS,
            scriptStep("format_message_list", MESSAGE_LIST_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_chat_history",
        "查看{{user}}聊天记录",
        "展开{{user}}和某个指定联系人或群的完整聊天记录。适用：已经在消息列表里锁定了可疑对象、或{{user}}明确提到某个人，需要核实两人具体说了什么。调用时必须用 target 或 sessionId 指定对象，优先填消息列表结果里的 sessionId，并限制读取条数。不适用：还不知道该查谁（先跑「查看{{user}}微信消息列表」或「查看{{user}}微信联系人」）。",
        schema({
            target: { type: "string", description: "联系人名、群名、会话名、角色 id 或 sessionId。优先使用消息列表结果里的 sessionId。" },
            sessionId: { type: "string", description: "可选。微信会话 id；提供后优先按 sessionId 精确查找。" },
            limit: { type: "number", description: "可选。读取最近多少条聊天记录，默认 30，最大 80。" },
            includeSystem: { type: "boolean", description: "可选。是否包含系统/工具类隐藏消息，默认 false。" },
        }),
        [
            ...CHAT_DATA_STEPS,
            scriptStep("format_chat_history", CHAT_HISTORY_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_week_calendar",
        "查看{{user}}本周日程",
        "读取{{user}}本周（按日历周，周一起算）的日程安排。适用：想知道{{user}}最近去了哪里、和谁见面、为什么说自己没空，或核对{{user}}口头说的行程是否属实。不适用：查微信聊天、购物消费或通讯录。",
        schema({
            date: { type: "string", description: "可选。YYYY-MM-DD。查看这个日期所在周的日程；不填则查看当前周。" },
            weekStart: { type: "string", description: "可选。YYYY-MM-DD，周一日期。提供后按这一周读取。" },
        }),
        [
            scriptStep("read_week_calendar", CALENDAR_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_shopping_orders",
        "查看{{user}}购物订单",
        "列出{{user}}最近的购物订单：商品、金额、下单时间、订单状态、物流与支付方式。适用：想查{{user}}最近买了什么、有没有给别人或暧昧对象下单，或从消费记录里反推他的生活状态与行踪。不适用：查聊天内容、见面行程或通讯录名单。",
        schema({
            limit: { type: "number", description: "可选。读取最近多少条购物订单，默认 10，最大 30。" },
            status: { type: "string", description: "可选。按订单状态或物流状态筛选，例如 已送达、配送中、待发货。" },
        }),
        [
            scriptStep("read_shopping_orders", ORDERS_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_people_brief",
        "查看{{user}}身边的人",
        "读取{{user}}手机资料里登记过的「身边人物」档案摘要（姓名、微信号、标签、性格简介），不是微信通讯录。适用：{{user}}提到一个陌生人、或你想了解某个角色和{{user}}是什么关系、有什么背景。这里只看人物卡片，不读最近聊天动态。不适用：判断{{user}}最近在和谁聊（用「查看{{user}}微信消息列表」）、或看通讯录里有哪些人（用「查看{{user}}微信联系人」）。",
        schema({
            query: { type: "string", description: "可选。按人物名称、微信号、标签或摘要筛选。" },
            limit: { type: "number", description: "可选。最多返回多少个人物摘要，默认 30，最大 80。" },
        }),
        [
            CHAT_DATA_STEPS[2],
            scriptStep("format_people", PEOPLE_SCRIPT),
        ],
    ),
];
