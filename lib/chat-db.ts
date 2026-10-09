// lib/chat-db.ts
// IndexedDB persistence layer for chat data using Dexie.js.
// Provides async persistence behind the synchronous in-memory cache in chat-storage.ts.

import Dexie from "dexie";
import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";

// ── Database Schema ──────────────────────────────

class ChatDatabase extends Dexie {
    messages!: Dexie.Table<ChatMessage, string>;
    sessions!: Dexie.Table<ChatSession, string>;
    contacts!: Dexie.Table<ChatContact, string>;

    constructor() {
        super("AiPhoneChatDB");
        this.version(1).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
        });
    }
}

export const chatDb = new ChatDatabase();

// ── Cloud sync（云端 SQLite 为准，IndexedDB 仅作本地离线 fallback）─────────────
// 所有写操作在落 IndexedDB 的同时 fire-and-forget 推到 /api/chat/*。
// 消息写入频繁，用 300ms 防抖合并批量提交，避免每条消息一次请求。

let _cloudMsgQueue: ChatMessage[] = [];
let _cloudMsgTimer: ReturnType<typeof setTimeout> | null = null;
const CLOUD_MSG_FLUSH_MS = 300;

// 已知 id 集合：用于 replace（全量覆盖列表）时 diff 出被删掉的 id，同步删云端。
const _knownSessionIds = new Set<string>();
const _knownContactIds = new Set<string>();

async function cloudPost(path: string, body: unknown): Promise<void> {
    if (typeof window === "undefined") return;
    const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`cloud ${path} failed: ${res.status}`);
}

function flushCloudMessages(): void {
    if (_cloudMsgTimer) { clearTimeout(_cloudMsgTimer); _cloudMsgTimer = null; }
    if (_cloudMsgQueue.length === 0) return;
    const batch = _cloudMsgQueue;
    _cloudMsgQueue = [];
    void cloudPost("/api/chat/messages", batch).catch(err =>
        console.warn("[ChatDB] cloud messages flush failed:", err));
}

function queueCloudMessages(msgs: ChatMessage[]): void {
    if (typeof window === "undefined" || msgs.length === 0) return;
    for (const m of msgs) _cloudMsgQueue.push(m);
    if (_cloudMsgTimer) return;
    _cloudMsgTimer = setTimeout(() => {
        _cloudMsgTimer = null;
        flushCloudMessages();
    }, CLOUD_MSG_FLUSH_MS);
}

/** 客户端水合用：拉取云端全量聊天状态。云端为准。 */
export async function fetchChatCloudState(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
}> {
    if (typeof window === "undefined") return { messages: [], sessions: [], contacts: [] };
    const res = await fetch("/api/chat/state", { cache: "no-store" });
    if (!res.ok) throw new Error(`chat state failed: ${res.status}`);
    const data = await res.json() as {
        ok?: boolean;
        messages?: ChatMessage[];
        sessions?: ChatSession[];
        contacts?: ChatContact[];
    };
    return {
        messages: Array.isArray(data?.messages) ? data.messages : [],
        sessions: Array.isArray(data?.sessions) ? data.sessions : [],
        contacts: Array.isArray(data?.contacts) ? data.contacts : [],
    };
}

/** 首次迁移用：本地 IndexedDB 全量上传到云端。 */
export async function uploadChatBatch(batch: {
    messages?: ChatMessage[];
    sessions?: ChatSession[];
    contacts?: ChatContact[];
}): Promise<void> {
    if (typeof window === "undefined") return;
    await Promise.all([
        batch.messages && batch.messages.length ? cloudPost("/api/chat/messages", batch.messages) : Promise.resolve(),
        batch.sessions && batch.sessions.length ? cloudPost("/api/chat/sessions", batch.sessions) : Promise.resolve(),
        batch.contacts && batch.contacts.length ? cloudPost("/api/chat/contacts", batch.contacts) : Promise.resolve(),
    ]);
}

/** 水合后登记已知 id，避免首次 replace 把云端数据误删。 */
export function rememberKnownChatIds(data: { sessions?: ChatSession[]; contacts?: ChatContact[] }): void {
    _knownSessionIds.clear();
    _knownContactIds.clear();
    for (const s of data.sessions ?? []) if (s.id) _knownSessionIds.add(s.id);
    for (const c of data.contacts ?? []) if (c.id) _knownContactIds.add(c.id);
}

// ── Initialization + Migration from localStorage ──

const LS_MESSAGES_KEY = "ai_phone_chat_messages_v1";
const LS_SESSIONS_KEY = "ai_phone_chat_sessions_v1";
const LS_CONTACTS_KEY = "ai_phone_chat_contacts_v1";
const LS_MIGRATED_FLAG = "ai_phone_idb_migrated_v1";

/**
 * Initialize IndexedDB and migrate data from localStorage if needed.
 * Returns the loaded data for the in-memory caches.
 */
export async function initChatDb(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
}> {
    if (typeof window === "undefined") {
        return { messages: [], sessions: [], contacts: [] };
    }

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // Guard against a lost migration flag while IndexedDB still holds data.
        // The flag lives in volatile localStorage; the actual data lives in the far
        // more durable IndexedDB. The flag can disappear independently of the data
        // (e.g. clearing the "cache" data module, privacy tooling, partial eviction).
        // If we blindly "re-migrated" from now-empty localStorage we would shadow
        // real data with empty caches, and the next write would wipe IndexedDB.
        // So when IDB already has data, treat it as already migrated and reuse it.
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            if (existingCount > 0) {
                window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
                const [messages, sessions, contacts] = await Promise.all([
                    chatDb.messages.toArray(),
                    chatDb.sessions.toArray(),
                    chatDb.contacts.toArray(),
                ]);
                console.log(`[ChatDB] Migration flag missing but IndexedDB has data; reusing it: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
                return { messages, sessions, contacts };
            }
        } catch (err) {
            console.warn("[ChatDB] Pre-migration IndexedDB check failed:", err);
        }

        // First run after migration: move localStorage data → IndexedDB
        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) {
                await chatDb.messages.bulkPut(lsMessages);
            }
            if (lsSessions.length > 0) {
                await chatDb.sessions.bulkPut(lsSessions);
            }
            if (lsContacts.length > 0) {
                await chatDb.contacts.bulkPut(lsContacts);
            }

            // Mark as migrated and remove old localStorage data
            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_MESSAGES_KEY);
            window.localStorage.removeItem(LS_SESSIONS_KEY);
            window.localStorage.removeItem(LS_CONTACTS_KEY);

            console.log(`[ChatDB] Migrated from localStorage: ${lsMessages.length} messages, ${lsSessions.length} sessions, ${lsContacts.length} contacts`);

            return { messages: lsMessages, sessions: lsSessions, contacts: lsContacts };
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            // If migration fails, load from localStorage as fallback
            const fallbackMessages: ChatMessage[] = safeParse(window.localStorage.getItem(LS_MESSAGES_KEY));
            const fallbackSessions: ChatSession[] = safeParse(window.localStorage.getItem(LS_SESSIONS_KEY));
            const fallbackContacts: ChatContact[] = safeParse(window.localStorage.getItem(LS_CONTACTS_KEY));
            return { messages: fallbackMessages, sessions: fallbackSessions, contacts: fallbackContacts };
        }
    }

    // Already migrated: load from IndexedDB (retry up to 3 times on failure)
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            console.log(`[ChatDB] Loaded from IndexedDB: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        } catch (err) {
            lastErr = err;
            console.warn(`[ChatDB] Load attempt ${attempt + 1}/3 failed:`, err);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                try { if (!chatDb.isOpen()) await chatDb.open(); } catch {}
            }
        }
    }
    console.error("[ChatDB] All load attempts failed:", lastErr);
    throw new Error("[ChatDB] Failed to load after 3 attempts");
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Async persistence helpers (fire-and-forget) ──

export function dbPutMessage(msg: ChatMessage): void {
    chatDb.messages.put(msg).catch(err => console.warn("[ChatDB] put message failed:", err));
    queueCloudMessages([msg]);
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    chatDb.messages.bulkPut(msgs).catch(err => console.warn("[ChatDB] bulkPut messages failed:", err));
    queueCloudMessages(msgs);
}

export function dbDeleteMessage(id: string): void {
    chatDb.messages.delete(id).catch(err => console.warn("[ChatDB] delete message failed:", err));
    void cloudPost("/api/chat/delete", { messages: [id] }).catch(err =>
        console.warn("[ChatDB] cloud delete message failed:", err));
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    chatDb.messages.where("sessionId").equals(sessionId).delete()
        .catch(err => console.warn("[ChatDB] delete session messages failed:", err));
    // 按 sessionId 的云端删除由调用方在拿到具体 id 后走 dbDeleteMessagesByIds。
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    chatDb.messages.bulkDelete(ids).catch(err => console.warn("[ChatDB] bulkDelete messages failed:", err));
    if (ids.length > 0) void cloudPost("/api/chat/delete", { messages: ids }).catch(err =>
        console.warn("[ChatDB] cloud delete messages failed:", err));
}

export function dbPutSession(session: ChatSession): void {
    chatDb.sessions.put(session).catch(err => console.warn("[ChatDB] put session failed:", err));
    _knownSessionIds.add(session.id);
    void cloudPost("/api/chat/sessions", [session]).catch(err =>
        console.warn("[ChatDB] cloud put session failed:", err));
}

export function dbPutSessions(sessions: ChatSession[]): void {
    chatDb.sessions.bulkPut(sessions).catch(err => console.warn("[ChatDB] bulkPut sessions failed:", err));
    for (const s of sessions) _knownSessionIds.add(s.id);
    if (sessions.length > 0) void cloudPost("/api/chat/sessions", sessions).catch(err =>
        console.warn("[ChatDB] cloud put sessions failed:", err));
}

export function dbReplaceSessions(sessions: ChatSession[]): void {
    chatDb.transaction("rw", chatDb.sessions, async () => {
        await chatDb.sessions.clear();
        await chatDb.sessions.bulkPut(sessions);
    }).catch(err => console.warn("[ChatDB] replace sessions failed:", err));
    // 云端是 upsert 语义：diff 出本次被移除的 session id，单独发删除。
    const incoming = new Set(sessions.map(s => s.id));
    const removed: string[] = [];
    for (const id of _knownSessionIds) if (!incoming.has(id)) removed.push(id);
    _knownSessionIds.clear();
    for (const s of sessions) _knownSessionIds.add(s.id);
    if (removed.length > 0) void cloudPost("/api/chat/delete", { sessions: removed }).catch(err =>
        console.warn("[ChatDB] cloud delete sessions failed:", err));
    if (sessions.length > 0) void cloudPost("/api/chat/sessions", sessions).catch(err =>
        console.warn("[ChatDB] cloud put sessions failed:", err));
}

export function dbDeleteSession(id: string): void {
    chatDb.sessions.delete(id).catch(err => console.warn("[ChatDB] delete session failed:", err));
    _knownSessionIds.delete(id);
    void cloudPost("/api/chat/delete", { sessions: [id] }).catch(err =>
        console.warn("[ChatDB] cloud delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    chatDb.contacts.bulkPut(contacts).catch(err => console.warn("[ChatDB] bulkPut contacts failed:", err));
    for (const c of contacts) _knownContactIds.add(c.id);
    if (contacts.length > 0) void cloudPost("/api/chat/contacts", contacts).catch(err =>
        console.warn("[ChatDB] cloud put contacts failed:", err));
}

export function dbClearContacts(): void {
    chatDb.contacts.clear().catch(err => console.warn("[ChatDB] clear contacts failed:", err));
    const removed = [..._knownContactIds];
    _knownContactIds.clear();
    if (removed.length > 0) void cloudPost("/api/chat/delete", { contacts: removed }).catch(err =>
        console.warn("[ChatDB] cloud clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    }).catch(err => console.warn("[ChatDB] replaceContacts failed:", err));
    const incoming = new Set(contacts.map(c => c.id));
    const removed: string[] = [];
    for (const id of _knownContactIds) if (!incoming.has(id)) removed.push(id);
    _knownContactIds.clear();
    for (const c of contacts) _knownContactIds.add(c.id);
    if (removed.length > 0) void cloudPost("/api/chat/delete", { contacts: removed }).catch(err =>
        console.warn("[ChatDB] cloud delete contacts failed:", err));
    if (contacts.length > 0) void cloudPost("/api/chat/contacts", contacts).catch(err =>
        console.warn("[ChatDB] cloud put contacts failed:", err));
}
