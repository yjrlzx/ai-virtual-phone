import { NextResponse } from "next/server";

// 共享推送预约通道已永久停用（push_jobs 表由旧 Supabase 侧的调度 worker 消费，
// 自托管环境已改走本地 scheduled_jobs + 进程内调度器，见 /api/push/schedule）。
// 旧客户端仍会打这三个方法，统一回 503 并缓存响应。

function sharedPushDisabledResponse() {
  return NextResponse.json(
    { ok: false, error: "本站共享离线推送预约已停用。" },
    {
      status: 503,
      headers: { "Cache-Control": "public, max-age=3600" },
    },
  );
}

export async function POST() {
  return sharedPushDisabledResponse();
}

export async function PATCH() {
  return sharedPushDisabledResponse();
}

export async function DELETE() {
  return sharedPushDisabledResponse();
}
