import { NextResponse } from "next/server";

import { upsertChatRows } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/chat/contacts  body: ChatContact[]（或 { contacts: ChatContact[] }）
// 批量 upsert 联系人到 chat_contacts。
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const arr: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.contacts)
        ? body.contacts
        : [];
    const rows = (arr as Array<Record<string, unknown>>)
      .filter(c => c && typeof c.id === "string")
      .map(c => ({
        id: c.id as string,
        characterId: typeof c.characterId === "string" ? c.characterId : "",
        addedAt: typeof c.addedAt === "string" ? c.addedAt : "",
        data: JSON.stringify(c),
      }));
    upsertChatRows("chat_contacts", rows);
    return NextResponse.json({ ok: true, count: rows.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
