import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { deleteSubscription, upsertSubscription } from "@/lib/server/push-store";

type SubscribeBody = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as SubscribeBody;
    const endpoint = cleanAccountText(body.endpoint, 1000);
    const p256dh = cleanAccountText(body.keys?.p256dh, 300);
    const auth = cleanAccountText(body.keys?.auth, 300);
    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ ok: false, error: "订阅数据不完整。" }, { status: 400 });
    }

    upsertSubscription({
      endpoint,
      userId: account.id,
      p256dh,
      auth,
      userAgent: cleanAccountText(request.headers.get("user-agent"), 300) || null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({})) as { endpoint?: unknown };
    const endpoint = cleanAccountText(body.endpoint, 1000);
    if (!endpoint) {
      return NextResponse.json({ ok: false, error: "缺少订阅端点。" }, { status: 400 });
    }
    deleteSubscription(endpoint, account.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
