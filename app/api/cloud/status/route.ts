// 自托管云服务状态：手机端"云服务部署"页只读这个接口，展示真实后端状态，
// 不再出现 Supabase Access Token / 部署按钮。
//   push: 订阅表行数 + 当前 SSE 在线长连接数
//   backup: 数据文件 data/float.db 的大小与最后修改时间
//   weixin: 微信云函数在自托管进程里没有运行时，恒为未启用

import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { countSubscriptionForUser } from "@/lib/server/push-store";
import { countShellListeners } from "@/lib/server/shell-bus";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }

    let dbBytes: number | null = null;
    let dbModifiedAt: string | null = null;
    try {
      const stat = fs.statSync(path.join(process.cwd(), "data", "float.db"));
      dbBytes = stat.size;
      dbModifiedAt = stat.mtime.toISOString();
    } catch {
      // 数据文件还没建出来就保持 null
    }

    return NextResponse.json({
      ok: true,
      serverUrl: new URL(request.url).origin,
      selfHosted: isSelfHostedModeEnabled(),
      push: {
        subscribed: countSubscriptionForUser(account.id) > 0,
        onlineSessions: countShellListeners(account.id),
      },
      backup: { dbBytes, dbModifiedAt },
      weixin: { enabled: false },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
