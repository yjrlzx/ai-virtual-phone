// lib/linjian-client.ts
// 掌心窗（linjian-peek）统一 server HTTP 客户端。
//
// 掌心窗 server（server/linjian_server.py）是一个零依赖 HTTP 服务：
//   - 所有命令走 POST /api/command { action, app, package, device_id, payload }，
//     手机端轮询 /api/poll 取命令执行，结果经 /api/command/status 回传；
//   - 截图走 POST /api/peek 敲门，手机截图上传后从 GET /api/latest 取回；
//   - 生活状态（天气地区等）走 GET /api/life_state。
//
// 地址 / Token / 设备号都从环境变量读，默认空：
//   - 没配 LINJIAN_URL 时，所有方法返回 null，调用方回退到壳端桥（window.AndroidShell）。
//   - 配了但连不上（网络/CORS/超时），同样返回 null 回退壳端。
//   - 掌心窗已应答（成功或失败）就直接用它的结果，避免对同一台手机重复下发指令。
//
// 客户端 / 服务端都能 import：模块加载期不碰 window。

const BASE: string = (
  process.env.NEXT_PUBLIC_LINJIAN_URL ||
  process.env.LINJIAN_URL ||
  ""
)
  .trim()
  .replace(/\/+$/, "");

const TOKEN: string = (
  process.env.NEXT_PUBLIC_LINJIAN_TOKEN ||
  process.env.LINJIAN_TOKEN ||
  ""
).trim();

const DEFAULT_DEVICE: string = (
  process.env.NEXT_PUBLIC_LINJIAN_DEFAULT_DEVICE ||
  process.env.LINJIAN_DEFAULT_DEVICE ||
  "android-phone"
).trim() || "android-phone";

/** 掌心窗是否已配置（配了地址才会尝试走它）。 */
export function isLinjianConfigured(): boolean {
  return Boolean(BASE);
}

/**
 * 统一调用结果。
 * - null：未配置 / 不可达，调用方应回退壳端桥。
 * - { ok: true, data }：掌心窗成功。
 * - { ok: false, error }：掌心窗已应答但执行失败，直接用该失败结果，不再回退（避免重复下发）。
 */
export type LinjianCall<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string }
  | null;

type QueuedCommand = {
  id?: string;
  action?: string;
  status?: string;
  result?: string;
  report?: unknown;
  [k: string]: unknown;
};

type CommandEnvelope = {
  ok?: boolean;
  command?: QueuedCommand;
};

async function request<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init?.headers || {}),
        ...(TOKEN ? { "X-Auth-Token": TOKEN } : {}),
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`linjian HTTP ${resp.status}: ${text || resp.statusText}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 下发一条手机命令，返回排队信封。失败（未配置/不可达）抛错给上层兜底。 */
async function postCommand(body: Record<string, unknown>): Promise<CommandEnvelope> {
  return request<CommandEnvelope>(
    "/api/command",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEFAULT_DEVICE, ...body }),
    },
    5000,
  );
}

/** 轮询命令执行结果（手机端异步执行）。 */
async function waitCommand(id: string, seconds = 6): Promise<CommandEnvelope | null> {
  const deadline = Date.now() + seconds * 1000;
  let last: CommandEnvelope | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      last = await request<CommandEnvelope>(
        `/api/command/status?id=${encodeURIComponent(id)}`,
        undefined,
        2000,
      );
      const status = last?.command?.status;
      if (status === "completed" || status === "failed") return last;
    } catch {
      /* 继续等到 deadline */
    }
  }
  return last;
}

/** 命令执行结果正文：优先 report.result，退到 command.result。 */
function commandResultText(env: CommandEnvelope | null): { ok: boolean; text: string } {
  const cmd = env?.command;
  if (!cmd) return { ok: false, text: "掌心窗未回传执行结果" };
  const report = (cmd.report || {}) as { result?: unknown; ok?: boolean };
  const text =
    typeof report.result === "string"
      ? report.result
      : typeof cmd.result === "string"
        ? cmd.result
        : JSON.stringify(report.result ?? cmd.result ?? "", null, 2);
  return { ok: cmd.status !== "failed", text };
}

// ── 对外能力：与 mascot-tools / 现实桥 UI 一一对齐 ──────────────

/** 锁 App（应用门禁 / 屏幕休息）。 */
export async function linjianLockApp(opts: {
  app?: string;
  package: string;
  durationMinutes?: number;
  message?: string;
  reason?: string;
}): Promise<LinjianCall<string>> {
  if (!isLinjianConfigured()) return null;
  try {
    const duration = Number(opts.durationMinutes) || 0;
    const payload = {
      app: opts.app || "",
      package: opts.package,
      duration_minutes: duration,
      mode: "medium",
      reason: opts.reason || "",
      message: opts.message || "",
    };
    const env = await postCommand({
      action: "lock_app",
      app: opts.app || "",
      package: opts.package,
      duration_minutes: duration,
      payload,
    });
    const id = env.command?.id;
    const done = id ? await waitCommand(id, 6) : env;
    const r = commandResultText(done);
    if (!r.ok) return { ok: false, error: r.text || "锁 App 失败" };
    const when = duration > 0 ? `，约 ${Math.min(duration, 1440)} 分钟后自动解开` : "（掌心窗门禁）";
    return { ok: true, data: `已通过掌心窗锁定 ${opts.package}${when}` };
  } catch {
    return null;
  }
}

/** 解锁 App（结束应用门禁）。 */
export async function linjianUnlockApp(opts: {
  app?: string;
  package: string;
  reason?: string;
}): Promise<LinjianCall<string>> {
  if (!isLinjianConfigured()) return null;
  try {
    const payload = { app: opts.app || "", package: opts.package, reason: opts.reason || "" };
    const env = await postCommand({
      action: "unlock_app",
      app: opts.app || "",
      package: opts.package,
      payload,
    });
    const id = env.command?.id;
    const done = id ? await waitCommand(id, 6) : env;
    const r = commandResultText(done);
    if (!r.ok) return { ok: false, error: r.text || "解锁 App 失败" };
    return { ok: true, data: `已通过掌心窗解锁 ${opts.package}` };
  } catch {
    return null;
  }
}

/** 读屏：拉取当前屏幕无障碍节点树（文字 / 控件 / 可点击 / 坐标）。 */
export async function linjianReadScreen(): Promise<LinjianCall<string>> {
  if (!isLinjianConfigured()) return null;
  try {
    const env = await postCommand({ action: "get_screen_nodes" });
    const id = env.command?.id;
    const done = id ? await waitCommand(id, 8) : env;
    const r = commandResultText(done);
    if (!r.ok) return { ok: false, error: r.text || "读屏失败" };
    return { ok: true, data: r.text };
  } catch {
    return null;
  }
}

/** 按文字点节点。 */
export async function linjianTapText(opts: {
  text: string;
  match?: "exact" | "contains";
  index?: number;
}): Promise<LinjianCall<string>> {
  if (!isLinjianConfigured()) return null;
  try {
    const target = opts.text;
    const match = opts.match || "contains";
    const index = Number.isFinite(opts.index) ? Number(opts.index) : 0;
    const env = await postCommand({
      action: "tap_text",
      target_text: target,
      match,
      index,
      payload: { target_text: target, match, index },
    });
    const id = env.command?.id;
    const done = id ? await waitCommand(id, 6) : env;
    const r = commandResultText(done);
    if (!r.ok) return { ok: false, error: r.text || "点文字失败" };
    return { ok: true, data: `已通过掌心窗点「${target}」` };
  } catch {
    return null;
  }
}

/** 截屏：敲门让手机截一张新图，等上传后取回 data URI。 */
export async function linjianScreenshot(): Promise<LinjianCall<string>> {
  if (!isLinjianConfigured()) return null;
  try {
    const before = await request<{ mtime?: number }>("/api/latest.json", undefined, 4000)
      .then((j) => Number(j.mtime || 0))
      .catch(() => 0);

    await request("/api/peek", { method: "POST" }, 4000);

    // 等一张新图上传（mtime 变化），最多等 20s
    const deadline = Date.now() + 20000;
    let infoMtime = before;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const info = await request<{ mtime?: number }>("/api/latest.json", undefined, 4000);
        infoMtime = Number(info.mtime || 0);
        if (infoMtime > before) break;
      } catch {
        /* 继续等 */
      }
    }
    if (infoMtime <= before) return { ok: false, error: "掌心窗截屏超时：手机未上传新图" };

    const dataUri = await fetchLatestAsDataUri();
    return { ok: true, data: dataUri };
  } catch {
    return null;
  }
}

async function fetchLatestAsDataUri(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(BASE + "/api/latest", {
      signal: controller.signal,
      headers: TOKEN ? { "X-Auth-Token": TOKEN } : {},
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("截屏转 data URI 失败"));
      reader.readAsDataURL(blob);
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读通知：掌心窗 server 不对外暴露通知读取（隐私原因，通知只在手机本地经壳端桥读）。
 * 始终返回 null，让上层回退壳端。方法保留是为了和工具清单一一对应。
 */
export async function linjianReadNotifications(): Promise<LinjianCall<string>> {
  return null;
}

/** 定系统闹钟。 */
export async function linjianSetAlarm(opts: {
  hour: number;
  minute: number;
  message?: string;
}): Promise<LinjianCall<string>> {
  if (!isLinjianConfigured()) return null;
  try {
    const env = await postCommand({
      action: "set_alarm",
      payload: {
        hour: Math.round(opts.hour),
        minute: Math.round(opts.minute),
        message: opts.message || "",
        vibrate: true,
        skip_ui: true,
      },
    });
    const id = env.command?.id;
    const done = id ? await waitCommand(id, 5) : env;
    const r = commandResultText(done);
    if (!r.ok) return { ok: false, error: r.text || "定闹钟失败" };
    const hm = `${Math.round(opts.hour)}:${String(Math.round(opts.minute)).padStart(2, "0")}`;
    return { ok: true, data: `已通过掌心窗设 ${hm}${opts.message ? `（${opts.message}）` : ""}` };
  } catch {
    return null;
  }
}

type LifeState = {
  state?: {
    city?: string;
    current_weather_location?: { city?: string; name?: string };
    latitude?: number;
    longitude?: number;
    lat?: number;
    lng?: number;
  };
  life_state?: LifeState["state"];
};

/** 读掌心窗生活状态里上报的天气地区 / 位置。 */
async function fetchLifeState(): Promise<LifeState | null> {
  if (!isLinjianConfigured()) return null;
  try {
    return await request<LifeState>(
      `/api/life_state?device_id=${encodeURIComponent(DEFAULT_DEVICE)}`,
      undefined,
      4500,
    );
  } catch {
    return null;
  }
}

/** 查天气：先用掌心窗上报的城市，再调 open-meteo（与壳端同一数据源）。 */
export async function linjianGetWeather(): Promise<LinjianCall<string>> {
  if (!isLinjianConfigured()) return null;
  try {
    const ls = await fetchLifeState();
    const cur = ls?.state?.current_weather_location || ls?.life_state?.current_weather_location || {};
    const city = (cur.city || ls?.state?.city || ls?.life_state?.city || "").trim();
    if (!city) return { ok: false, error: "掌心窗未上报天气地区，先在手机端设置当前城市" };

    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
    ).then((r) => r.json());
    const hit = geo?.results?.[0];
    if (!hit) return { ok: false, error: `天气城市未找到：${city}` };

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
    const j = (await fetch(url).then((r) => r.json())) as {
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
    };
    const c = j.current ?? {};
    return {
      ok: true,
      data: `${cur.name || city}（掌心窗地区）当前 ${c.temperature_2m ?? "?"}°C，湿度 ${c.relative_humidity_2m ?? "?"}%，风速 ${c.wind_speed_10m ?? "?"} km/h`,
    };
  } catch {
    return null;
  }
}

/**
 * 定位：掌心窗 server 不做实时 GPS，只持有手机上报的城市级位置。
 * 若生活状态里带了经纬度就返回，否则返回 null 让上层回退壳端实时定位。
 */
export async function linjianGetLocation(): Promise<LinjianCall<string>> {
  if (!isLinjianConfigured()) return null;
  try {
    const ls = await fetchLifeState();
    const s = ls?.state || ls?.life_state || {};
    const lat = Number(s.latitude ?? s.lat);
    const lng = Number(s.longitude ?? s.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { ok: true, data: `纬度 ${lat}，经度 ${lng}（掌心窗上报位置，非实时 GPS）` };
  } catch {
    return null;
  }
}
