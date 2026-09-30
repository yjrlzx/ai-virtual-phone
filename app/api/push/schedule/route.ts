// 网页端给"角色设闹钟 / 约早安电话"的接口：写一行 scheduled_jobs，
// 到点由 lib/server/scheduler.ts 扫描后经 SSE 推给壳。
// POST {runAt(epoch ms), type: "message"|"call", title, body, url?, sessionId?, characterName?}
// GET  列出当前账号未来 24h 待触发任务。

import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { insertScheduledJob, listUpcomingJobs } from "@/lib/server/push-store";

const MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1000;
const UPCOMING_HORIZON_MS = 24 * 60 * 60 * 1000;
const ALLOWED_TYPES = new Set(["message", "call"]);

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const runAt = Number(body.runAt);
    const type = cleanAccountText(body.type, 20);
    const title = cleanAccountText(body.title, 120);
    const text = cleanAccountText(body.body, 500);
    const url = cleanAccountText(body.url, 300) || "/";
    const sessionId = cleanAccountText(body.sessionId, 120) || null;
    const characterName = cleanAccountText(body.characterName, 80) || null;

    if (!Number.isFinite(runAt) || runAt <= Date.now()) {
      return NextResponse.json({ ok: false, error: "runAt 必须是未来的时间戳。" }, { status: 400 });
    }
    if (runAt > Date.now() + MAX_FUTURE_MS) {
      return NextResponse.json({ ok: false, error: "预约时间太远，最多 30 天。" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(type)) {
      return NextResponse.json({ ok: false, error: "type 只能是 message 或 call。" }, { status: 400 });
    }
    if (!title) {
      return NextResponse.json({ ok: false, error: "缺少标题。" }, { status: 400 });
    }
    if (type === "call" && !sessionId) {
      return NextResponse.json({ ok: false, error: "来电任务需要 sessionId。" }, { status: 400 });
    }

    const id = `sched_${crypto.randomUUID()}`;
    insertScheduledJob({
      id,
      userId: account.id,
      runAt,
      type,
      payload: JSON.stringify({ title, body: text, url, sessionId, characterName }),
    });
    return NextResponse.json({ ok: true, id, runAt });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const rows = listUpcomingJobs(account.id, Date.now() + UPCOMING_HORIZON_MS);
    return NextResponse.json({
      ok: true,
      jobs: rows.map(row => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(row.payload) as Record<string, unknown>;
        } catch {
          // 损坏的 payload 原样留空，不影响列表
        }
        return {
          id: row.id,
          runAt: row.run_at,
          type: row.type,
          title: typeof payload.title === "string" ? payload.title : "",
          body: typeof payload.body === "string" ? payload.body : "",
        };
      }),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
