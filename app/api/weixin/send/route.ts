// app/api/weixin/send/route.ts
// 浏览器端生成 char 回复后，调本路由把文本通过微信客服消息接口推回公众号用户。
import { NextResponse } from "next/server";
import { sendWeixinCustomText } from "@/lib/server/weixin-access";
import { getCurrentAccount } from "@/lib/server/account-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { openid?: string; text?: string } = {};
  try { body = await request.json(); } catch { /* ignore */ }
  if (!body.openid || !body.text) {
    return NextResponse.json({ error: "missing openid or text" }, { status: 400 });
  }

  try {
    await sendWeixinCustomText(body.openid, body.text);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "send_failed", message: msg }, { status: 502 });
  }
}
