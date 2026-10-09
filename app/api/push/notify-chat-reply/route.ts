// 聊天回复离线推送：角色生成回复、而聊天房间在后台（用户切走/杀后台/锁屏）时，
// 客户端 fire-and-forget 调本接口，服务端解析会话所属用户并下发推送。
//
// 两路推送在 sendPushToUser 内部已合一：
//   - 安卓壳（华为 P60 WebView）→ emitShellNotify → SSE 长连接 → 系统通知
//   - Web / PWA → web-push（VAPID）→ service worker 通知
// 自托管模式下 getCurrentAccount 恒为 local_user，单用户直接命中订阅。

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { resolvePushSubject, sendPushToUser } from "@/lib/server/push-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  sessionId?: unknown;
  charName?: unknown;
  replyText?: unknown;
  url?: unknown;
};

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });

    const body = await request.json().catch(() => ({})) as Body;
    const sessionId = clean(body.sessionId, 120);
    const charName = clean(body.charName, 60) || "角色";
    const replyText = clean(body.replyText, 600);
    if (!sessionId) return NextResponse.json({ ok: false, error: "缺少 sessionId。" }, { status: 400 });

    // 通知正文用回复摘要，压缩空白后截断 ~80 字；title 用角色名
    const summary = replyText.replace(/\s+/g, " ").slice(0, 80) || "发来一条新消息";
    const providedUrl = clean(body.url, 500);
    const base = new URL("/", request.url);
    const url = providedUrl
      ? (providedUrl.startsWith("/") ? new URL(providedUrl, base).toString() : providedUrl)
      : base.toString();

    const result = await sendPushToUser(account.id, {
      title: charName,
      body: summary,
      tag: `chat-reply:${sessionId}`,
      url,
      sessionId,
      characterName: charName,
    }, resolvePushSubject(request.url));

    // fire-and-forget：无订阅 / 发送失败都不向前端抛错，避免影响聊天主流程
    return NextResponse.json({ ok: true, sent: result.sent, total: result.total });
  } catch (err) {
    // 兜底也返回 200：推送是增强能力，绝不阻塞或报错给聊天链路
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 200 });
  }
}
