"use client";

// 聊天回复离线推送客户端：聊天房间在后台时，角色回复落库后调用本函数上报。
// 极简 fire-and-forget：失败静默，绝不能影响聊天主流程或抛错到 UI。

type NotifyInput = {
  sessionId: string;
  charName: string;
  replyText: string;
  url?: string;
};

export function notifyChatReplyBackground(input: NotifyInput): void {
  try {
    const body = {
      sessionId: input.sessionId,
      charName: input.charName,
      replyText: input.replyText,
      url: input.url,
    };
    fetch("/api/push/notify-chat-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 静默：推送是增强能力
  }
}
