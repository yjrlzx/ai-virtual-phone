import { NextResponse } from "next/server";

import { getAllChatState } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/chat/state → 全量聊天数据（客户端启动水合用）
// 返回 { ok, contacts, sessions, messages }，云端 SQLite 为准。
export async function GET() {
  try {
    const state = getAllChatState();
    return NextResponse.json({ ok: true, ...state });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
