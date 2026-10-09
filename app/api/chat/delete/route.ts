import { NextResponse } from "next/server";

import { deleteChatRows } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/chat/delete
// body: { messages?: string[], sessions?: string[], contacts?: string[] }
// 按主键 id 删除消息 / 会话 / 联系人。
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const asIdArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    deleteChatRows({
      messageIds: asIdArray(body?.messages),
      sessionIds: asIdArray(body?.sessions),
      contactIds: asIdArray(body?.contacts),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
