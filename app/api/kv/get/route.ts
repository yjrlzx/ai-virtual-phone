import { NextResponse } from "next/server";

import { getAllKvEntries, getKvValue } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/kv/get?key=xxx  → 读取单个键
// GET /api/kv/get          → 读取全量（启动水合用）
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (key !== null) {
      const value = getKvValue(key);
      return NextResponse.json({ ok: true, value });
    }
    const entries = getAllKvEntries();
    return NextResponse.json({ ok: true, entries });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
