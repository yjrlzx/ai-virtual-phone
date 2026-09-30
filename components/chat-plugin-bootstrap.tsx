"use client";

// components/chat-plugin-bootstrap.tsx
// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。
// 放在根布局，保证插件的 hook 在用户进入聊天前就已注册。

import { useEffect } from "react";
import { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";

export function ChatPluginBootstrap() {
    useEffect(() => {
        void getChatPluginRuntime().ensureStarted();
        // 陆知行首启播种：动态 import，避免模块作用域碰浏览器 API，
        // 老 WebView（华为 P60 HarmonyOS）里即使 IndexedDB/kv 异常也不崩 hydration。
        void import("@/lib/luzhixing-seed")
            .then(m => m.seedLuzhixingIfFirstRun())
            .catch(err => console.warn("[Bootstrap] seed skipped:", err));
    }, []);
    return null;
}
