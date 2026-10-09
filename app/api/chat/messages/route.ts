import { NextResponse } from "next/server";

import { upsertChatRows } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/chat/messages  body: ChatMessage[]（或 { messages: ChatMessage[] }）
// 批量 upsert 消息到 chat_messages。
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const arr: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.messages)
        ? body.messages
        : [];
    const rows = (arr as Array<Record<string, unknown>>)
      .filter(m => m && typeof m.id === "string")
      .map(m => ({
        id: m.id as string,
        sessionId: typeof m.sessionId === "string" ? m.sessionId : "",
        createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
        data: JSON.stringify(m),
      }));
    upsertChatRows("chat_messages", rows);
    return NextResponse.json({ ok: true, count: rows.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
