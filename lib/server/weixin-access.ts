// lib/server/weixin-access.ts
// 微信公众号 access_token 获取与缓存（kv 表，提前 5 分钟刷新）。
import { getKvValue, setKvValue } from "./kv-store";

type CachedToken = { accessToken: string; expiresAt: number };

const KV_KEY = "weixin_access_token_v1";

export type WeixinConfig = {
  appId: string;
  appSecret: string;
  token: string;
  encodingAesKey?: string;
};

export function getWeixinConfig(): WeixinConfig | null {
  const raw = getKvValue("weixin_config_v1");
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as Partial<WeixinConfig>;
    if (!cfg.appId || !cfg.appSecret || !cfg.token) return null;
    return {
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      token: cfg.token,
      encodingAesKey: cfg.encodingAesKey || undefined,
    };
  } catch {
    return null;
  }
}

export async function getWeixinAccessToken(): Promise<string> {
  const cfg = getWeixinConfig();
  if (!cfg) throw new Error("weixin_not_configured");

  const cachedRaw = getKvValue(KV_KEY);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CachedToken;
      if (cached.accessToken && cached.expiresAt > Date.now() + 5 * 60_000) {
        return cached.accessToken;
      }
    } catch {
      // fall through and refresh
    }
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appId)}&secret=${encodeURIComponent(cfg.appSecret)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  if (!data.access_token) {
    throw new Error(`weixin_token_failed: ${data.errcode ?? "?"} ${data.errmsg ?? res.status}`);
  }
  setKvValue(KV_KEY, JSON.stringify({
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  } satisfies CachedToken));
  return data.access_token;
}

export async function sendWeixinCustomText(openid: string, text: string): Promise<void> {
  const token = await getWeixinAccessToken();
  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touser: openid,
      msgtype: "text",
      text: { content: text.slice(0, 600) },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { errcode?: number; errmsg?: string };
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`weixin_send_failed: ${data.errcode} ${data.errmsg}`);
  }
}
