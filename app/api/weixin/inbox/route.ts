// app/api/weixin/inbox/route.ts
// 浏览器端轮询：拿待回复的微信消息，处理完后回告已处理。
import { NextResponse } from "next/server";
import { listPendingWeixinInbox, markWeixinInboxReplied } from "@/lib/server/push-store";
import { getCurrentAccount } from "@/lib/server/account-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = listPendingWeixinInbox(20);
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { id?: string } = {};
  try { body = await request.json(); } catch { /* ignore */ }
  if (!body.id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  markWeixinInboxReplied(body.id);
  return NextResponse.json({ ok: true });
}
