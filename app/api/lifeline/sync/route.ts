import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { emitLifelineSync, type LifelineSyncEvent } from "@/lib/server/shell-bus";
import { getLifelineState, upsertLifelineState } from "@/lib/server/push-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/lifeline/sync
//   返回当前用户 lifeline 整库状态（JSON 字符串）+ updated_at + version。
//   没有写过就返回 ok:true, state:null。
export async function GET(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const row = getLifelineState(account.id);
  return NextResponse.json({
    ok: true,
    state: row?.state ?? null,
    updatedAt: row?.updated_at ?? 0,
    version: row?.version ?? 0,
  });
}

// POST /api/lifeline/sync  body: { state: string, updatedAt: number }
//   last-write-wins：仅当 body.updatedAt >= 服务端 updated_at 才落库；
//   落库成功后经 shell-bus 的 lifeline 频道广播，让同一用户的其他端重拉。
//   被服务端较新数据驳回时返回 { ok:false, conflict:true, state, updatedAt, version }，
//   客户端据此直接用服务端版本覆盖本地。
export async function POST(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const state = typeof body?.state === "string" ? body.state : "";
  const updatedAt = Number(body?.updatedAt);
  if (!state || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return NextResponse.json({ ok: false, error: "bad_payload" }, { status: 400 });
  }

  const existing = getLifelineState(account.id);
  if (existing && updatedAt < existing.updated_at) {
    return NextResponse.json({
      ok: false,
      conflict: true,
      state: existing.state,
      updatedAt: existing.updated_at,
      version: existing.version,
    });
  }

  const row = upsertLifelineState(account.id, state, updatedAt);
  if (!row) {
    // 并发下被抢先写了，回服务端当前版本
    const cur = getLifelineState(account.id);
    return NextResponse.json({
      ok: false,
      conflict: true,
      state: cur?.state ?? null,
      updatedAt: cur?.updated_at ?? 0,
      version: cur?.version ?? 0,
    });
  }

  const ev: LifelineSyncEvent = { type: "lifeline_sync", updatedAt: row.updated_at, version: row.version };
  emitLifelineSync(account.id, ev);
  return NextResponse.json({ ok: true, updatedAt: row.updated_at, version: row.version });
}
