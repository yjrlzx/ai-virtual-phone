// 服务端 Web Push：VAPID 密钥自举 + 面向账号的推送发送。
// 密钥存本地 SQLite push_server_config（首次调用自动生成），订阅存 push_subscriptions。
// 安卓壳（FloatShell App）的长连接收消息走进程内 EventEmitter（shell-bus.ts）
// + SSE 路由（app/api/push/stream），不再依赖 Supabase Realtime。

import { randomBytes } from "node:crypto";

import {
  deleteSubscription,
  getVapidConfigRow,
  listSubscriptionsByUser,
  touchSubscriptionSuccess,
  upsertVapidConfig,
} from "./push-store";
import { emitShellNotify } from "./shell-bus";

// web-push 是纯 Node 包（依赖 https-proxy-agent → net/http/https），
// 必须动态 import，避免 Next 在 build 时沿静态引用链把它打进客户端/edge bundle。
let _webpush: typeof import("web-push") | null = null;
async function loadWebpush(): Promise<typeof import("web-push")> {
  if (!_webpush) _webpush = (await import("web-push")).default;
  return _webpush;
}

type VapidKeys = { publicKey: string; privateKey: string };

export type PushMessage = {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  type?: "shortcut_command";
  commandId?: string;
  ttl?: number;
};

export type PushSendResult = {
  sent: number;
  total: number;
  errors: string[];
};

/** 广播给安卓壳的消息载荷：type=call 时壳直接拉起全屏来电页。 */
export type ShellBroadcastMessage = {
  type?: "message" | "call";
  title: string;
  body: string;
  url?: string;
  sessionId?: string;
  characterName?: string;
  callTs?: number;
};

// 安卓壳（FloatShell App）注册的合成订阅端点前缀：不做 Web Push，
// 改由进程内总线（SSE 长连接）送达。
const SHELL_ENDPOINT_PREFIX = "shell:";

/** 向某用户的在线壳连接广播一条通知（尽力而为，同步返回是否有在线接收端）。 */
export function broadcastShellNotify(userId: string, message: ShellBroadcastMessage): boolean {
  return emitShellNotify(userId, {
    type: message.type === "call" ? "call" : "message",
    title: message.title,
    body: message.body,
    url: message.url || "/",
    sessionId: message.sessionId,
    characterName: message.characterName,
    callTs: message.callTs,
  });
}

/** VAPID subject 必须是 https: 或 mailto:。本地 http 环境回退到 mailto。 */
export function resolvePushSubject(requestUrl: string): string {
  try {
    const origin = new URL(requestUrl).origin;
    if (origin.startsWith("https://")) return origin;
  } catch {
    // fall through
  }
  return "mailto:push@ai-virtual-phone.local";
}

export async function getOrCreateVapidConfig(): Promise<VapidKeys> {
  const existing = getVapidConfigRow();
  if (existing) {
    // 老行补齐 cron_secret / payload_key
    upsertVapidConfig({
      vapid_public_key: existing.vapid_public_key,
      vapid_private_key: existing.vapid_private_key,
      cron_secret: existing.cron_secret || randomBytes(24).toString("hex"),
      payload_key: existing.payload_key || randomBytes(32).toString("hex"),
    });
    return { publicKey: existing.vapid_public_key, privateKey: existing.vapid_private_key };
  }

  const wp = await loadWebpush();
  const keys = wp.generateVAPIDKeys();
  upsertVapidConfig({
    vapid_public_key: keys.publicKey,
    vapid_private_key: keys.privateKey,
    cron_secret: randomBytes(24).toString("hex"),
    payload_key: randomBytes(32).toString("hex"),
  });
  return keys;
}

/** 快照加解密密钥：存本地表共享，Next 路由统一从同一来源读取。 */
export async function getOrCreatePushPayloadKey(): Promise<string> {
  const existing = getVapidConfigRow();
  if (existing?.payload_key) return existing.payload_key;
  // 行不存在或列为空：走 VAPID 自举顺带补齐，再读一次
  await getOrCreateVapidConfig();
  const again = getVapidConfigRow();
  const key = again?.payload_key;
  if (!key) throw new Error("payload_key bootstrap failed");
  return key;
}

/** 给某个账号的所有订阅设备发一条推送。404/410 的失效订阅顺手清掉。 */
export async function sendPushToUser(
  userId: string,
  message: PushMessage,
  subject: string,
): Promise<PushSendResult> {
  const vapid = await getOrCreateVapidConfig();
  const subs = listSubscriptionsByUser(userId);

  const navigate = (() => {
    if (message.url) {
      try {
        return new URL(message.url, subject.startsWith("https://") ? subject : undefined).toString();
      } catch {
        // Keep the supplied value for legacy service-worker handling.
        return message.url;
      }
    }
    return subject.startsWith("https://") ? subject : "/";
  })();
  const assetOrigin = (() => {
    try {
      return new URL(navigate).origin;
    } catch {
      return "";
    }
  })();
  // Declarative Web Push lets current Safari navigate notifications without
  // relying on WebKit's inconsistent notificationclick/openWindow handling.
  // Older browsers receive the same JSON in the service worker, which parses
  // this shape and displays an imperative fallback notification.
  const payload = JSON.stringify({
    web_push: 8030,
    notification: {
      title: message.title,
      body: message.body,
      navigate,
      tag: message.tag,
      icon: assetOrigin ? `${assetOrigin}/icon-192.png` : undefined,
      badge: assetOrigin ? `${assetOrigin}/icon-192.png` : undefined,
      silent: false,
      mutable: false,
      data: {
        url: navigate,
        type: message.type || "",
        commandId: message.commandId || "",
      },
    },
  });
  const result: PushSendResult = { sent: 0, total: subs.length, errors: [] };

  const shellSubs = subs.filter(sub => sub.endpoint.startsWith(SHELL_ENDPOINT_PREFIX));
  const webSubs = subs.filter(sub => !sub.endpoint.startsWith(SHELL_ENDPOINT_PREFIX));
  if (shellSubs.length > 0) {
    const ok = broadcastShellNotify(userId, { title: message.title, body: message.body, url: navigate });
    if (ok) result.sent += shellSubs.length;
    else result.errors.push("shell not connected");
  }

  for (const sub of webSubs) {
    try {
      const wp = await loadWebpush();
      await wp.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        {
          vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: Math.max(30, Math.min(86_400, Number(message.ttl) || 3600)),
        },
      );
      result.sent += 1;
      touchSubscriptionSuccess(sub.endpoint);
    } catch (err) {
      const statusCode = typeof err === "object" && err && "statusCode" in err
        ? Number((err as { statusCode?: unknown }).statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        // 订阅已在系统侧失效（用户删了 PWA / 撤销授权）——清掉这行。
        deleteSubscription(sub.endpoint, userId);
      } else {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return result;
}
