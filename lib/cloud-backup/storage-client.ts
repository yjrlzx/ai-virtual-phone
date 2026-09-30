import type { CloudBackupConfig } from "./config";

/**
 * 自托管备份文件客户端：同源 Next.js 路由 /api/cloud-backup/<path>，
 * 走 cookie/session 鉴权，文件落云服务器 data/cloud-backup/<userId>/。
 * 不再需要 Supabase URL/key/apikey/Bearer。保留超时/重试/进度/分块逻辑。
 */

function objectUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  const encoded = clean.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `/api/cloud-backup/${encoded}`;
}

// ── hang / flake protection ──
const CONTROL_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_HEADER_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60 * 1000;
const UPLOAD_TIMEOUT_FLOOR_MS = 2 * 60 * 1000;
const UPLOAD_TIMEOUT_CAP_MS = 20 * 60 * 1000;
const RETRY_DELAYS_MS = [1500, 4000];

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) return true;
  return /^5\d\d(\s|$)|超时|timed? ?out|networkerror|failed to fetch|load failed/i.test(message);
}

async function withRetries<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${what}超时（${Math.round(timeoutMs / 1000)} 秒无响应），请检查网络后重试。`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type DownloadProgress = (receivedBytes: number, totalBytes: number | null) => void;

async function responseToBlob(res: Response, onBytes?: DownloadProgress): Promise<Blob> {
  const contentType = res.headers.get("Content-Type") ?? "";
  const lengthHeader = res.headers.get("Content-Length");
  const totalBytes = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (!res.body) return await res.blob();
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`下载超时（${Math.round(DOWNLOAD_IDLE_TIMEOUT_MS / 1000)} 秒没有收到数据），请检查网络后重试。`)), DOWNLOAD_IDLE_TIMEOUT_MS);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        if (value) {
          chunks.push(value as unknown as BlobPart);
          received += value.byteLength;
          onBytes?.(received, totalBytes);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  return new Blob(chunks, { type: contentType });
}

/** Upload (overwrites if present). Body can be a Blob/ArrayBuffer/string. */
export async function putObject(_config: CloudBackupConfig, path: string, body: BlobPart, contentType = "application/octet-stream"): Promise<void> {
  const blob = body instanceof Blob ? body : new Blob([body], { type: contentType });
  const timeoutMs = Math.min(UPLOAD_TIMEOUT_CAP_MS, UPLOAD_TIMEOUT_FLOOR_MS + Math.ceil(blob.size / 1024) * 25);
  await withRetries(async () => {
    const res = await fetchWithTimeout(objectUrl(path), {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: blob,
    }, timeoutMs, "上传");
    if (!res.ok) throw new Error(await describeError(res));
  });
}

/** Download an object's bytes. Returns null if the object doesn't exist. */
export async function getObject(_config: CloudBackupConfig, path: string, onBytes?: DownloadProgress): Promise<Blob | null> {
  return withRetries(async () => {
    const res = await fetchWithTimeout(objectUrl(path), { cache: "no-store" }, DOWNLOAD_HEADER_TIMEOUT_MS, "下载");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await describeError(res));
    return await responseToBlob(res, onBytes);
  });
}

/** 删除并返回是否由本次调用真正删掉（200）。404 = 已被别处取走。 */
export async function claimObject(_config: CloudBackupConfig, path: string): Promise<boolean> {
  const res = await fetchWithTimeout(objectUrl(path), { method: "DELETE" }, CONTROL_TIMEOUT_MS, "删除");
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(await describeError(res));
}

export async function removeObject(_config: CloudBackupConfig, path: string): Promise<void> {
  await withRetries(async () => {
    const res = await fetchWithTimeout(objectUrl(path), { method: "DELETE" }, CONTROL_TIMEOUT_MS, "删除");
    if (res.ok || res.status === 404) return;
    throw new Error(await describeError(res));
  });
}

export type StorageObject = { name: string; size: number; updatedAt?: string };

/** List objects under a prefix. 返回 name 相对 prefix（与原 Supabase 行为一致）。 */
export async function listObjects(
  _config: CloudBackupConfig,
  prefix = "",
  limit = 100,
  _sort?: { column: "name" | "created_at" | "updated_at"; order: "asc" | "desc" },
  _offset = 0,
): Promise<StorageObject[]> {
  const url = objectUrl(prefix).replace(/\/+$/, "") + `/?list=1&limit=${limit}`;
  const res = await withRetries(() => fetchWithTimeout(url, { cache: "no-store" }, CONTROL_TIMEOUT_MS, "列举"));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await describeError(res));
  const rows = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: String(row.name ?? ""),
      size: Number(row.size ?? 0),
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined,
    }))
    .filter((item) => item.name);
}

/** 自托管：目录第一次写时自动建，no-op。 */
export async function ensureBucket(_config: CloudBackupConfig): Promise<void> {
  return;
}

/** 探活：写一个小探测文件再删掉。 */
export async function testCloudBackupConnection(_config: CloudBackupConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  const probePath = `.healthcheck/${Date.now()}.txt`;
  try {
    await putObject(_config, probePath, "ok", "text/plain");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try { await removeObject(_config, probePath); } catch { /* ignore */ }
  return { ok: true };
}

async function describeError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    message = String(data.message ?? data.error ?? text);
  } catch { /* keep raw */ }
  return `${res.status} ${message || res.statusText}`.trim();
}
