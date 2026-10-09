import { NextResponse } from "next/server";

import { upsertChatRows } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/chat/sessions  body: ChatSession[]（或 { sessions: ChatSession[] }）
// 批量 upsert 会话到 chat_sessions。
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const arr: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.sessions)
        ? body.sessions
        : [];
    const rows = (arr as Array<Record<string, unknown>>)
      .filter(s => s && typeof s.id === "string")
      .map(s => ({
        id: s.id as string,
        contactId: typeof s.contactId === "string" ? s.contactId : "",
        updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
        data: JSON.stringify(s),
      }));
    upsertChatRows("chat_sessions", rows);
    return NextResponse.json({ ok: true, count: rows.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
