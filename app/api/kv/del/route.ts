import { NextResponse } from "next/server";

import { deleteKvValue } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/kv/del  body: { key: string }
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const key = typeof body?.key === "string" ? body.key : "";
    if (!key) {
      return NextResponse.json({ ok: false, error: "missing_key" }, { status: 400 });
    }
    deleteKvValue(key);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
