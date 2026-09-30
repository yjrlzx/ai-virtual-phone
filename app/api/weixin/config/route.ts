// 微信接入配置（自托管）：存服务器 SQLite kv，不再走 Supabase edge function。
// GET 回显时把 secret 字段掩码，避免前端回显泄露。
import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { getKvValue, setKvValue } from "@/lib/server/kv-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "weixin_config_v1";

type WeixinConfig = {
  appId?: string;
  appSecret?: string;
  token?: string;
  encodingAesKey?: string;
};

function mask(v?: string): string {
  if (!v) return "";
  if (v.length <= 4) return "••••";
  return v.slice(0, 4) + "••••" + v.slice(-2);
}

export async function GET(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const raw = getKvValue(KEY);
  const cfg: WeixinConfig = raw ? (JSON.parse(raw) as WeixinConfig) : {};
  return NextResponse.json({
    ok: true,
    enabled: Boolean(cfg.appId && cfg.token),
    appId: cfg.appId ?? "",
    appSecret: mask(cfg.appSecret),
    token: mask(cfg.token),
    encodingAesKey: mask(cfg.encodingAesKey),
  });
}

export async function POST(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const next: WeixinConfig = {
    appId: typeof body?.appId === "string" ? body.appId.trim() : "",
    token: typeof body?.token === "string" ? body.token.trim() : "",
  };
  // 掩码回显的字段不覆盖原值：用户没改就保持原样
  const existingRaw = getKvValue(KEY);
  const existing: WeixinConfig = existingRaw ? (JSON.parse(existingRaw) as WeixinConfig) : {};
  next.appSecret = typeof body?.appSecret === "string" && !body.appSecret.includes("•") && body.appSecret.trim()
    ? body.appSecret.trim()
    : (existing.appSecret ?? "");
  next.encodingAesKey = typeof body?.encodingAesKey === "string" && !body.encodingAesKey.includes("•") && body.encodingAesKey.trim()
    ? body.encodingAesKey.trim()
    : (existing.encodingAesKey ?? "");
  if (!next.appId || !next.token) {
    return NextResponse.json({ ok: false, error: "AppID 和 Token 必填" }, { status: 400 });
  }
  setKvValue(KEY, JSON.stringify(next));
  return NextResponse.json({ ok: true, enabled: true });
}
