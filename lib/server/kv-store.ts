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
  _db = db;
  return db;
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
