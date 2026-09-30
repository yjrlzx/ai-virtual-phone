// lib/weixin-mp-bridge.ts
// 微信公众号消息桥（和已有的 iLink 个人微信桥不同）：
// 轮询 /api/weixin/inbox 拿公众号用户发来的消息，注入 float 主聊天会话
// （和用户在 float 里聊天走同一个 chat-storage / chat-engine，共享记忆），
// 生成回复后 POST /api/weixin/send 走微信客服消息接口推回。
//
// 前提：char 的人设/记忆/LLM key 都在浏览器端，服务端不能自己生成回复；
// 所以这个桥必须由开着的 float 浏览器 tab 来驱动。

import {
  loadChatContacts,
  loadChatSessions,
  createOrGetSession,
  loadChatMessages,
  pushChatMessage,
} from "./chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import { parseAIResponse } from "./rich-message-parser";

let started = false;
let busy = false;

async function processOne(item: { id: string; openid: string; msg_type: string; content: string }): Promise<void> {
  const contacts = loadChatContacts();
  const contact = contacts[0];
  if (!contact) return; // 还没建角色，先不回

  const session = createOrGetSession(contact.characterId);
  const history = loadChatMessages(session.id);
  const userMsg = pushChatMessage({ sessionId: session.id, role: "user", content: item.content });

  let rawReply: string;
  try {
    rawReply = flattenCompletionResult(
      await generateChatCompletion(session, [...history, userMsg], { appTags: ["chat", "text"] }, {}),
    );
  } catch (err) {
    console.warn("[weixin-mp] generate failed", err);
    return;
  }

  const { parts } = parseAIResponse(rawReply, []);
  const text = parts
    .filter(p => !p.mediaType)
    .map(p => (p.content || "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 600);

  // 助手消息也写进本地会话（记忆共享，和 float 里聊一样）
  if (text) {
    pushChatMessage({ sessionId: session.id, role: "assistant", content: text });
  }

  if (text) {
    try {
      await fetch("/api/weixin/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openid: item.openid, text }),
      });
    } catch (err) {
      console.warn("[weixin-mp] send failed", err);
    }
  }

  try {
    await fetch("/api/weixin/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id }),
    });
  } catch { /* ignore */ }
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const res = await fetch("/api/weixin/inbox", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { items?: Array<{ id: string; openid: string; msg_type: string; content: string }> };
    for (const item of data.items ?? []) {
      await processOne(item);
    }
  } catch { /* 暂不可达，下一轮再来 */ } finally {
    busy = false;
  }
}

export function startWeixinMpBridge(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void tick();
  window.setInterval(() => void tick(), 5000);
  void loadChatSessions(); // 触发一次 hydration
}
