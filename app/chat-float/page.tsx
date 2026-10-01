"use client";

import { ChatFloatErrorBoundary } from "./error-boundary";
import { FloatChatRoom } from "@/components/chat/float-chat-room";

export default function ChatFloatPage() {
  return (
    <ChatFloatErrorBoundary>
      <FloatChatRoom />
    </ChatFloatErrorBoundary>
  );
}
