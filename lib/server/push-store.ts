// 推送链路本地持久层：复用 data/float.db 同一个 node:sqlite 连接（见 kv-store.ts）。
// 替代原 Supabase 的 push_server_config / push_subscriptions，并新增 scheduled_jobs
// 给自建调度器（lib/server/scheduler.ts）存到点任务。
//
// 表结构：
//   push_server_config(id TEXT PRIMARY KEY = 'main', vapid_public_key, vapid_private_key,
//                      cron_secret, payload_key, updated_at)
//   push_subscriptions(endpoint TEXT PRIMARY KEY, user_id, p256dh, auth,
//                      user_agent, fail_count, last_ok_at, created_at)
//   scheduled_jobs(id TEXT PRIMARY KEY, user_id, run_at INTEGER(epoch ms), type,
//                  payload TEXT(JSON), fired INTEGER DEFAULT 0, created_at INTEGER)

import type { DatabaseSync } from "node:sqlite";

import { getDatabase } from "./kv-store";

export type VapidConfigRow = {
  vapid_public_key: string;
  vapid_private_key: string;
  cron_secret: string | null;
  payload_key: string | null;
};

export type PushSubscriptionRow = {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  fail_count: number;
  last_ok_at: string | null;
};

export type ScheduledJobRow = {
  id: string;
  user_id: string;
  run_at: number;
  type: string;
  payload: string;
  fired: number;
};

function db(): DatabaseSync {
  const conn = getDatabase();
  conn.exec(`CREATE TABLE IF NOT EXISTS push_server_config (
    id TEXT PRIMARY KEY,
    vapid_public_key TEXT NOT NULL,
    vapid_private_key TEXT NOT NULL,
    cron_secret TEXT,
    payload_key TEXT,
    updated_at TEXT NOT NULL
  )`);
  conn.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_ok_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  conn.exec(`CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(fired, run_at)`);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user ON scheduled_jobs(user_id, fired, run_at)`);
  conn.exec(`CREATE TABLE IF NOT EXISTS lifeline_state (
    user_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
  )`);
  conn.exec(`CREATE TABLE IF NOT EXISTS weixin_inbox (
    id TEXT PRIMARY KEY,
    openid TEXT NOT NULL,
    msg_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    replied INTEGER NOT NULL DEFAULT 0
  )`);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_weixin_inbox_pending ON weixin_inbox(replied, created_at)`);
  return conn;
}

// ── VAPID / 推送密钥配置 ──

export function getVapidConfigRow(): VapidConfigRow | null {
  const row = db()
    .prepare("SELECT vapid_public_key, vapid_private_key, cron_secret, payload_key FROM push_server_config WHERE id = 'main'")
    .get() as VapidConfigRow | undefined;
  return row ?? null;
}

export function upsertVapidConfig(values: {
  vapid_public_key: string;
  vapid_private_key: string;
  cron_secret?: string | null;
  payload_key?: string | null;
}): void {
  const existing = getVapidConfigRow();
  db().prepare(
    `INSERT INTO push_server_config (id, vapid_public_key, vapid_private_key, cron_secret, payload_key, updated_at)
     VALUES ('main', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       vapid_public_key = excluded.vapid_public_key,
       vapid_private_key = excluded.vapid_private_key,
       cron_secret = COALESCE(excluded.cron_secret, push_server_config.cron_secret),
       payload_key = COALESCE(excluded.payload_key, push_server_config.payload_key),
       updated_at = excluded.updated_at`,
  ).run(
    values.vapid_public_key,
    values.vapid_private_key,
    values.cron_secret ?? existing?.cron_secret ?? null,
    values.payload_key ?? existing?.payload_key ?? null,
    new Date().toISOString(),
  );
}

// ── Web Push 订阅 ──

export function listSubscriptionsByUser(userId: string): PushSubscriptionRow[] {
  return db()
    .prepare("SELECT endpoint, user_id, p256dh, auth, user_agent, fail_count, last_ok_at FROM push_subscriptions WHERE user_id = ?")
    .all(userId) as PushSubscriptionRow[];
}

export function countSubscriptionForUser(userId: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?")
    .get(userId) as { n: number };
  return Number(row.n);
}

export function upsertSubscription(values: {
  endpoint: string;
  userId: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}): void {
  db().prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, fail_count, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent`,
  ).run(
    values.endpoint,
    values.userId,
    values.p256dh,
    values.auth,
    values.userAgent,
    new Date().toISOString(),
  );
}

export function touchSubscriptionSuccess(endpoint: string): void {
  db().prepare("UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?")
    .run(new Date().toISOString(), endpoint);
}

export function deleteSubscription(endpoint: string, userId: string): void {
  db().prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
    .run(endpoint, userId);
}

// ── 定时推送任务（scheduler 用） ──

export function insertScheduledJob(job: {
  id: string;
  userId: string;
  runAt: number;
  type: string;
  payload: string;
}): void {
  db().prepare(
    `INSERT INTO scheduled_jobs (id, user_id, run_at, type, payload, fired, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(job.id, job.userId, job.runAt, job.type, job.payload, Date.now());
}

export function listUpcomingJobs(userId: string, horizonMs: number): ScheduledJobRow[] {
  return db().prepare(
    `SELECT id, user_id, run_at, type, payload, fired FROM scheduled_jobs
     WHERE user_id = ? AND fired = 0 AND run_at <= ?
     ORDER BY run_at ASC LIMIT 100`,
  ).all(userId, horizonMs) as ScheduledJobRow[];
}

export function listDueJobs(nowMs: number, limit: number): ScheduledJobRow[] {
  return db().prepare(
    `SELECT id, user_id, run_at, type, payload, fired FROM scheduled_jobs
     WHERE fired = 0 AND run_at <= ?
     ORDER BY run_at ASC LIMIT ?`,
  ).all(nowMs, limit) as ScheduledJobRow[];
}

export function markJobFired(id: string): void {
  db().prepare("UPDATE scheduled_jobs SET fired = 1 WHERE id = ?").run(id);
}

// ── lifeline 云同步（一行 per user，JSON blob + updated_at，last-write-wins） ──

export type LifelineStateRow = {
  state: string;
  updated_at: number;
  version: number;
};

export function getLifelineState(userId: string): LifelineStateRow | null {
  const row = db()
    .prepare("SELECT state, updated_at, version FROM lifeline_state WHERE user_id = ?")
    .get(userId) as LifelineStateRow | undefined;
  return row ?? null;
}

/**
 * LWW upsert。仅当传入 updatedAt >= 服务端现有 updated_at 时写入，
 * version 自增。返回写入后的行；被服务端较新数据驳回时返回 null。
 */
export function upsertLifelineState(userId: string, state: string, updatedAt: number): LifelineStateRow | null {
  const existing = getLifelineState(userId);
  if (existing && updatedAt < existing.updated_at) return null;
  const nextVersion = (existing?.version ?? 0) + 1;
  db().prepare(
    `INSERT INTO lifeline_state (user_id, state, updated_at, version)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at,
       version = excluded.version`,
  ).run(userId, state, updatedAt, nextVersion);
  return { state, updated_at: updatedAt, version: nextVersion };
}

// ── 微信公众号入站消息（用户在公众号发的消息先落库，浏览器端拉取生成回复） ──

export type WeixinInboxRow = {
  id: string;
  openid: string;
  msg_type: string;
  content: string;
  created_at: number;
  replied: number;
};

export function insertWeixinInbox(row: { id: string; openid: string; msgType: string; content: string }): void {
  db().prepare(
    `INSERT INTO weixin_inbox (id, openid, msg_type, content, created_at, replied)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(row.id, row.openid, row.msgType, row.content, Date.now());
}

export function listPendingWeixinInbox(limit = 20): WeixinInboxRow[] {
  return db().prepare(
    `SELECT id, openid, msg_type, content, created_at, replied FROM weixin_inbox
     WHERE replied = 0 ORDER BY created_at ASC LIMIT ?`,
  ).all(limit) as WeixinInboxRow[];
}

export function markWeixinInboxReplied(id: string): void {
  db().prepare("UPDATE weixin_inbox SET replied = 1 WHERE id = ?").run(id);
}
