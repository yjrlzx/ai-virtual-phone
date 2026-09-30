// 自建壳推送长连接：SSE（Server-Sent Events），替代原 Supabase Realtime broadcast。
//
// GET /api/push/stream：用登录 Cookie 鉴权拿到 userId，然后挂在进程内
// shell-bus 的个人频道上；服务端 emitShellNotify 一触发，这里就把
// {type,title,body,url,...} 写成一行 `data: {...}\n\n` 推给壳。
// 客户端断连（request.signal abort / stream cancel）时退订，避免监听泄漏。

import { getCurrentAccount } from "@/lib/server/account-auth";
import { subscribeShellNotify, subscribeLifelineSync, type ShellNotify, type LifelineSyncEvent } from "@/lib/server/shell-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;

export async function GET(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) {
    return new Response("unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let unsubscribeLifeline: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      write(`data: ${JSON.stringify({ type: "hello", userId: account.id })}\n\n`);

      unsubscribe = subscribeShellNotify(account.id, (notify: ShellNotify) => {
        write(`data: ${JSON.stringify(notify)}\n\n`);
      });

      unsubscribeLifeline = subscribeLifelineSync(account.id, (ev: LifelineSyncEvent) => {
        write(`data: ${JSON.stringify(ev)}\n\n`);
      });

      heartbeat = setInterval(() => {
        // SSE 注释行做心跳，防中间代理/网关 idle 超时断流
        write(": ping\n\n");
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribeLifeline?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribeLifeline?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
