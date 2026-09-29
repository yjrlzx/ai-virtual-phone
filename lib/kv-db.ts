// lib/kv-db.ts
// 云端 SQLite 支撑的键值存储，带同步内存缓存。
// 真实数据源是 Next.js API（app/api/kv/*），落盘到服务端 data/float.db；
// 浏览器侧只保留一份内存缓存，启动时一次性水合，读写不再经过 IndexedDB / localStorage。

// ── In-memory cache ──
const _cache = new Map<string, string>();
let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;
let _hydrateError: unknown = null;

// ── Legacy localStorage migration registry ──
const _fixedKeys: string[] = [];
const _dynamicPrefixes: string[] = [];

export function registerKvMigration(lsKey: string): void {
    _fixedKeys.push(lsKey);
    // 若水合已跑完（模块被懒加载），立刻把这个键从 localStorage 上传到云端，
    // 否则它会永远留在浏览器里。
    if (_hydrated) migrateLegacyKey(lsKey);
}

export function registerDynamicPrefix(prefix: string): void {
    _dynamicPrefixes.push(prefix);
    if (_hydrated) migrateLegacyPrefix(prefix);
}

function matchesDynamicPrefix(key: string): boolean {
    return _dynamicPrefixes.some(prefix => key.startsWith(prefix));
}

// 把单个遗留 localStorage 键上传到云端并写进缓存，然后从 localStorage 删除。
function migrateLegacyKey(lsKey: string): void {
    if (typeof window === "undefined") return;
    const raw = localStorage.getItem(lsKey);
    if (raw === null) return;
    if (_cache.get(lsKey) !== raw) {
        _cache.set(lsKey, raw);
        void remoteSet(lsKey, raw).catch(err =>
            console.warn("[KvDB] migration upload failed:", lsKey, err));
    }
    localStorage.removeItem(lsKey);
}

function migrateLegacyPrefix(prefix: string): void {
    if (typeof window === "undefined") return;
    const matched: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) matched.push(k);
    }
    for (const k of matched) migrateLegacyKey(k);
}

// ── Remote API helpers ──
async function remoteSet(key: string, value: string): Promise<void> {
    const res = await fetch("/api/kv/set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
    });
    if (!res.ok) throw new Error(`kv set failed: ${res.status}`);
}

async function remoteDelete(key: string): Promise<void> {
    const res = await fetch("/api/kv/del", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error(`kv del failed: ${res.status}`);
}

// ── Hydration (call once at app startup) ──
// 成功才置 _hydrated，失败清掉在途 promise 允许下次重试。
export function hydrateKvDb(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return Promise.resolve();
    if (_hydratePromise) return _hydratePromise;
    _hydratePromise = (async () => {
        const res = await fetch("/api/kv/get", { cache: "no-store" });
        if (!res.ok) throw new Error(`kv get all failed: ${res.status}`);
        const data = await res.json() as { ok: boolean; entries?: Array<{ key: string; value: string }> };
        if (data && Array.isArray(data.entries)) {
            for (const { key, value } of data.entries) {
                if (!_cache.has(key)) _cache.set(key, value);
            }
        }

        // 把残留的遗留 localStorage 键上传到云端，然后清掉。
        const uploads: Array<{ key: string; value: string }> = [];
        const removeKeys = new Set<string>();

        for (const lsKey of _fixedKeys) {
            const raw = localStorage.getItem(lsKey);
            if (raw === null) continue;
            if (_cache.get(lsKey) !== raw) {
                uploads.push({ key: lsKey, value: raw });
                _cache.set(lsKey, raw);
            }
            removeKeys.add(lsKey);
        }

        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !matchesDynamicPrefix(k)) continue;
            const raw = localStorage.getItem(k);
            if (raw !== null) {
                if (_cache.get(k) !== raw) {
                    uploads.push({ key: k, value: raw });
                    _cache.set(k, raw);
                }
                removeKeys.add(k);
            }
        }

        if (uploads.length > 0) {
            await Promise.all(uploads.map(u => remoteSet(u.key, u.value).catch(err =>
                console.warn("[KvDB] migration upload failed:", u.key, err))));
        }
        for (const k of removeKeys) {
            try { localStorage.removeItem(k); } catch { /* localStorage 清理失败可忽略 */ }
        }
    })().then(() => {
        _hydrated = true;
        _hydrateError = null;
        _hydratePromise = null;
    }).catch(err => {
        console.warn("[KvDB] hydration failed, will retry on next call:", err);
        _hydrateError = err;
        _hydratePromise = null;
    });
    return _hydratePromise;
}

/** 最近一次水合失败的错误（成功后清空）。配合 isKvHydrated() 判断失败态。 */
export function getKvHydrationError(): unknown {
    return _hydrateError;
}

// ── Synchronous read (in-memory cache only) ──
/** kv 是否已水合完成。以 kv 内容为安全依据的流程必须先确认此状态。 */
export function isKvHydrated(): boolean {
    return _hydrated;
}

export function kvGet(key: string): string | null {
    const cached = _cache.get(key);
    if (cached !== undefined) return cached;
    return null;
}

// ── Write: update cache + fire-and-forget to server ──
export function kvSet(key: string, value: string): void {
    _cache.set(key, value);
    void remoteSet(key, value).catch(err =>
        console.warn("[KvDB] set failed:", key, err));
}

export async function kvSetAsync(key: string, value: string): Promise<void> {
    _cache.set(key, value);
    await remoteSet(key, value);
}

// ── Delete ──
export function kvRemove(key: string): void {
    _cache.delete(key);
    void remoteDelete(key).catch(err =>
        console.warn("[KvDB] delete failed:", key, err));
}

// ── Iterate keys with a prefix (for dynamic keys) ──
export function kvKeysWithPrefix(prefix: string): string[] {
    const result: string[] = [];
    for (const k of _cache.keys()) {
        if (k.startsWith(prefix)) result.push(k);
    }
    return result;
}

export function kvEntries(): Array<{ key: string; value: string }> {
    return Array.from(_cache.entries()).map(([key, value]) => ({ key, value }));
}
