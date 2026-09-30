import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { countSubscriptionForUser } from "@/lib/server/push-store";

export async function GET(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    return NextResponse.json({ ok: true, subscribed: countSubscriptionForUser(account.id) > 0 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
