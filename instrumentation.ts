// Next.js instrumentation：node 运行时启动后跑一次，拉起自建推送调度器。
// 调度器必须在进程启动时就运行，不能等第一条 SSE 连接到来。

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startPushScheduler } = await import("@/lib/server/scheduler");
  startPushScheduler();
}
