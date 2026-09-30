// 自建壳推送总线：进程内 EventEmitter，替代原 Supabase Realtime broadcast。
//
// 服务端任何模块要给安卓壳推消息时调用 emitShellNotify(userId, notify)；
// SSE 路由（app/api/push/stream）按 userId subscribe，把事件写进响应流。
// 单进程内通信，不需要额外的 WebSocket 服务器。

import { EventEmitter } from "node:events";

export type ShellNotify = {
  type: "message" | "call";
  title: string;
  body: string;
  url?: string;
  sessionId?: string;
  characterName?: string;
  callTs?: number;
};

type ShellBusListener = (notify: ShellNotify) => void;

let bus: EventEmitter | null = null;

function getBus(): EventEmitter {
  if (bus) return bus;
  const instance = new EventEmitter();
  // 同一用户可能有多条 SSE 连接（多标签页 / 重连残留），不限制监听数。
  instance.setMaxListeners(0);
  bus = instance;
  return instance;
}

function channelKey(userId: string): string {
  return `shell:${userId}`;
}

/** 向指定用户的所有在线壳连接广播一条通知。返回是否存在至少一个在线接收端。 */
export function emitShellNotify(userId: string, notify: ShellNotify): boolean {
  return getBus().emit(channelKey(userId), notify);
}

/** 订阅某用户的壳通知；返回的函数用于退订（SSE 断连时调用）。 */
export function subscribeShellNotify(userId: string, listener: ShellBusListener): () => void {
  const key = channelKey(userId);
  const instance = getBus();
  instance.on(key, listener);
  return () => {
    instance.off(key, listener);
  };
}

/** 当前该用户挂着几条在线 SSE 长连接（= 几条壳在线）。 */
export function countShellListeners(userId: string): number {
  return getBus().listenerCount(channelKey(userId));
}

// ── lifeline 云同步频道：一端 POST 后，服务端 emit，他端 SSE 收到重拉 ──

export type LifelineSyncEvent = {
  type: "lifeline_sync";
  updatedAt: number;
  version: number;
};

function lifelineChannelKey(userId: string): string {
  return `lifeline:${userId}`;
}

export function emitLifelineSync(userId: string, ev: LifelineSyncEvent): boolean {
  return getBus().emit(lifelineChannelKey(userId), ev);
}

export function subscribeLifelineSync(userId: string, listener: (ev: LifelineSyncEvent) => void): () => void {
  const key = lifelineChannelKey(userId);
  const instance = getBus();
  instance.on(key, listener);
  return () => {
    instance.off(key, listener);
  };
}
