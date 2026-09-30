import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { getOrCreateVapidConfig } from "@/lib/server/push-service";

export async function GET(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const vapid = await getOrCreateVapidConfig();
    return NextResponse.json({ ok: true, publicKey: vapid.publicKey });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
