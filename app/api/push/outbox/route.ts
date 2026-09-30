import { NextResponse } from "next/server";

// 共享离线推送回传通道已永久停用：旧版 PWA 会轮询这里，统一回 503，
// 并让浏览器/CDN 缓存住响应，把残余轮询挡在函数外。自托管环境的壳推送
// 走 /api/push/stream（SSE），不再经过本接口。

function cachedSharedPushDisabledResponse() {
  return NextResponse.json(
    { ok: false, error: "本站共享离线推送回传已停用。" },
    {
      status: 503,
      headers: {
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}

export async function GET() {
  return cachedSharedPushDisabledResponse();
}

export async function POST() {
  return cachedSharedPushDisabledResponse();
}
