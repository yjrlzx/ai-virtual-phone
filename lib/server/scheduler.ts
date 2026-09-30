// 自建推送调度器：进程内 setInterval 每秒扫一次 scheduled_jobs，到点就通过
// 壳总线（shell-bus）把消息推给在线的安卓壳。type=call 的任务直接发来电载荷，
// 壳端收到后拉起 IncomingCallActivity 全屏响铃——网页端"角色约早安电话"全靠它。
//
// 启动入口：instrumentation.ts 的 register() 在 node 运行时启动后调用一次。
// 用 globalThis 兜底，避免 Next dev 热重载 / 路由重复 import 造出多份定时器。

import { emitShellNotify } from "./shell-bus";
import { listDueJobs, markJobFired } from "./push-store";

const TICK_MS = 1000;
const SWEEP_LIMIT = 50;

type StoredPayload = {
  title?: unknown;
  body?: unknown;
  url?: unknown;
  sessionId?: unknown;
  characterName?: unknown;
};

const globalScope = globalThis as unknown as {
  __floatPushSchedulerTimer?: ReturnType<typeof setInterval>;
};

function sweep(): void {
  const now = Date.now();
  const jobs = listDueJobs(now, SWEEP_LIMIT);
  for (const job of jobs) {
    try {
      const data = JSON.parse(job.payload) as StoredPayload;
      const isCall = job.type === "call";
      emitShellNotify(job.user_id, {
        type: isCall ? "call" : "message",
        title: typeof data.title === "string" && data.title ? data.title : "小手机",
        body: typeof data.body === "string" ? data.body : "",
        url: typeof data.url === "string" ? data.url : "/",
        sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
        characterName: typeof data.characterName === "string" ? data.characterName : undefined,
        callTs: isCall ? now : undefined,
      });
    } catch {
      // 单条任务异常不影响其他任务
    }
    markJobFired(job.id);
  }
}

export function startPushScheduler(): void {
  if (globalScope.__floatPushSchedulerTimer) return;
  sweep();
  globalScope.__floatPushSchedulerTimer = setInterval(sweep, TICK_MS);
}
