import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * 服务端 KV 持久层：node:sqlite 单例，落盘到 data/float.db。
 * 表结构 kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)。
 * 路由处理器无状态，这里用模块级变量缓存连接，避免每次请求重开文件。
 */

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "float.db");

let _db: DatabaseSync | null = null;

export function getDatabase(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  initChatTables(db);
  _db = db;
  return db;
}

// ── Chat tables (messages / sessions / contacts) ──────────────────────────────
// 整对象以 JSON 存在 data 列，冗余列（sessionId/createdAt/contactId/...）仅建索引与排查用。
// 与 kv 共用同一个 float.db 连接（node:sqlite 单例）。

type ChatTable = "chat_messages" | "chat_sessions" | "chat_contacts";

type ChatRowInput = {
  id: string;
  data: string;
  sessionId?: string;
  createdAt?: string;
  contactId?: string;
  updatedAt?: string;
  characterId?: string;
  addedAt?: string;
};

function initChatTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(sessionId);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(createdAt);
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      contactId TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_contact ON chat_sessions(contactId);
    CREATE TABLE IF NOT EXISTS chat_contacts (
      id TEXT PRIMARY KEY,
      characterId TEXT NOT NULL DEFAULT '',
      addedAt TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_contacts_character ON chat_contacts(characterId);
  `);
}

export function upsertChatRows(table: ChatTable, rows: ChatRowInput[]): void {
  if (!rows || rows.length === 0) return;
  const db = getDatabase();
  if (table === "chat_messages") {
    const stmt = db.prepare(
      "INSERT INTO chat_messages (id, sessionId, createdAt, data) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, createdAt = excluded.createdAt, data = excluded.data",
    );
    for (const r of rows) stmt.run(r.id, r.sessionId ?? "", r.createdAt ?? "", r.data);
    return;
  }
  if (table === "chat_sessions") {
    const stmt = db.prepare(
      "INSERT INTO chat_sessions (id, contactId, updatedAt, data) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET contactId = excluded.contactId, updatedAt = excluded.updatedAt, data = excluded.data",
    );
    for (const r of rows) stmt.run(r.id, r.contactId ?? "", r.updatedAt ?? "", r.data);
    return;
  }
  const stmt = db.prepare(
    "INSERT INTO chat_contacts (id, characterId, addedAt, data) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET characterId = excluded.characterId, addedAt = excluded.addedAt, data = excluded.data",
  );
  for (const r of rows) stmt.run(r.id, r.characterId ?? "", r.addedAt ?? "", r.data);
}

export function deleteChatRows(ids: {
  messageIds?: string[];
  sessionIds?: string[];
  contactIds?: string[];
}): void {
  const db = getDatabase();
  if (ids.messageIds && ids.messageIds.length > 0) {
    const stmt = db.prepare("DELETE FROM chat_messages WHERE id = ?");
    for (const id of ids.messageIds) stmt.run(id);
  }
  if (ids.sessionIds && ids.sessionIds.length > 0) {
    const stmt = db.prepare("DELETE FROM chat_sessions WHERE id = ?");
    for (const id of ids.sessionIds) stmt.run(id);
  }
  if (ids.contactIds && ids.contactIds.length > 0) {
    const stmt = db.prepare("DELETE FROM chat_contacts WHERE id = ?");
    for (const id of ids.contactIds) stmt.run(id);
  }
}

/** 全量读取聊天数据（启动水合用）。data 列是 JSON 字符串，这里 parse 成对象数组。 */
export function getAllChatState(): {
  messages: unknown[];
  sessions: unknown[];
  contacts: unknown[];
} {
  const db = getDatabase();
  const parse = (rows: Array<{ data: string }>) =>
    rows.map(r => {
      try { return JSON.parse(r.data); } catch { return null; }
    }).filter(Boolean);
  const messages = parse(db.prepare("SELECT data FROM chat_messages").all() as Array<{ data: string }>);
  const sessions = parse(db.prepare("SELECT data FROM chat_sessions").all() as Array<{ data: string }>);
  const contacts = parse(db.prepare("SELECT data FROM chat_contacts").all() as Array<{ data: string }>);
  return { messages, sessions, contacts };
}

export function getAllKvEntries(): Array<{ key: string; value: string }> {
  const db = getDatabase();
  const rows = db.prepare("SELECT key, value FROM kv").all() as Array<{ key: string; value: string }>;
  return rows;
}

export function getKvValue(key: string): string | null {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setKvValue(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteKvValue(key: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}
