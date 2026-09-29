import { NextResponse } from "next/server";

import { setKvValue } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/kv/set  body: { key: string, value: string }
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const key = typeof body?.key === "string" ? body.key : "";
    const value = typeof body?.value === "string" ? body.value : "";
    if (!key) {
      return NextResponse.json({ ok: false, error: "missing_key" }, { status: 400 });
    }
    setKvValue(key, value);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
