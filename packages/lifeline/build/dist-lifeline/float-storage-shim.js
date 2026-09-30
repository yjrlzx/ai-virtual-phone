/**
 * float-storage-shim.js
 * ------------------------------------------------------------------
 * lifeline 的 localStorage 兼容代理。本脚本在 lifeline 主体脚本之前执行，
 * 共适配三种运行环境：
 *
 * 1) float 虚拟手机沙盒 iframe（srcDoc, origin=null）：原生 localStorage /
 *    IndexedDB / cookie 全部不可用（访问即抛 SecurityError）。此时 window.AiPhone
 *    存在，把 localStorage 替换成内存 Map 同步代理，异步回写宿主 AiPhone.db
 *    （collection='lifeline'，主键=storage key）。
 *
 * 2) float Next 同源部署（components/lifeline-app.tsx 用 <iframe src="/lifeline/index.html">
 *    挂载，无 window.AiPhone）：数据主源是服务端 SQLite（/api/lifeline/sync，
 *    表 lifeline_state，一行 per user，JSON blob + updated_at，last-write-wins）。
 *    启动用同步 XHR 预灌；setItem(主键) 后防抖 2.5s POST；同时监听
 *    /api/push/stream 的 lifeline_sync 事件，他端改了就 reload 拉新。
 *
 * 3) 直接用普通浏览器打开 index.html（file:// 或静态托管，无 /api/lifeline/sync）：
 *    探测失败，本脚本什么都不做，原样保留原生 localStorage。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ===== 可配置常量 ===== */
  var DB_KEY = 'lifeLineState_v2';          // lifeline 主数据键
  var COLLECTION = 'lifeline';               // float 集合名（已在 [\w.-] 白名单内）
  var UPLOAD_DEBOUNCE_MS = 2500;             // 写后防抖上传窗口

  // 提前抓住原生 localStorage 引用：一次性遗留数据迁移用。
  var nativeLS = (typeof window !== 'undefined') ? window.localStorage : null;

  /* ==================================================================
   * 环境 1：float 沙盒（有 window.AiPhone）。原有逻辑原样保留。
   * ================================================================== */
  if (window.AiPhone) {
    /* ===== 内存状态 ===== */
    var store = Object.create(null);   // key -> string value
    var known = Object.create(null);    // key -> true（已存在于 float db）
    var preloadDone = false;            // 预灌是否已完成
    var bootSawEmpty = false;           // 预灌完成前，getItem(DB_KEY) 是否读到 null
    var dbKeyWritten = false;           // 预灌完成前是否已经 setItem(DB_KEY)（用户已操作）
    var alreadyReloaded = !!(window.name && window.name.indexOf('llShimReloaded=1') >= 0);

    /* ===== 异步回写 float db（失败仅警告，绝不抛出，不阻塞 lifeline 同步流程） ===== */
    function persist(key, value, existed) {
      try {
        if (existed) {
          AiPhone.db.update(COLLECTION, key, { value: value }).then(null, function (e) {
            console.warn('llShim: db update failed', key, e);
          });
        } else {
          AiPhone.db.create(COLLECTION, { id: key, value: value }).then(function () {
            known[key] = true;
          }, function (e) {
            // 可能已存在（并发/竞态），退化为 update 再试一次
            AiPhone.db.update(COLLECTION, key, { value: value }).then(null, function (e2) {
              console.warn('llShim: db write failed', key, e2);
            });
          });
        }
      } catch (e) {
        console.warn('llShim: persist error', key, e);
      }
    }

    /* ===== localStorage 兼容代理 ===== */
    var shimLS = {
      getItem: function (key) {
        key = String(key);
        var v = (key in store) ? store[key] : null;
        if (key === DB_KEY && !preloadDone && v === null) { bootSawEmpty = true; }
        return v;
      },
      setItem: function (key, value) {
        key = String(key); value = String(value);
        var existed = (key in store);
        store[key] = value;
        if (key === DB_KEY) { dbKeyWritten = true; }
        persist(key, value, existed);
      },
      removeItem: function (key) {
        key = String(key);
        delete store[key];
        delete known[key];
        try {
          AiPhone.db.delete(COLLECTION, key).then(null, function (e) {
            console.warn('llShim: db delete failed', key, e);
          });
        } catch (e) { console.warn('llShim: removeItem error', key, e); }
      },
      clear: function () {
        var keys = Object.keys(store);
        store = Object.create(null);
        known = Object.create(null);
        keys.forEach(function (k) {
          try {
            AiPhone.db.delete(COLLECTION, k).then(null, function (e) {
              console.warn('llShim: db clear delete failed', k, e);
            });
          } catch (e) {}
        });
      },
      key: function (index) {
        var ks = Object.keys(store);
        return (index >= 0 && index < ks.length) ? ks[index] : null;
      }
    };
    Object.defineProperty(shimLS, 'length', {
      get: function () { return Object.keys(store).length; },
      enumerable: false,
      configurable: true
    });

    // 挂到 window.localStorage（宿主沙盒里原生对象访问会抛错，直接赋值即可）
    try {
      window.localStorage = shimLS;
    } catch (assignErr) {
      try {
        Object.defineProperty(window, 'localStorage', { value: shimLS, configurable: true, writable: true });
      } catch (defineErr) {
        console.warn('llShim: cannot install localStorage proxy', defineErr);
      }
    }

    /* ===== 环境探测标志（供帮助页等其它脚本探测） ===== */
    window.__llFloatBridge = true;
    window.__llShimReady = {
      isReady: function () { return preloadDone; },
      getCollection: COLLECTION,
      isFloatEnv: true
    };

    /* ===== 预灌 + 就绪补偿 ===== */
    function onPreloadRows(rows) {
      preloadDone = true;
      rows = rows || [];
      rows.forEach(function (r) {
        if (r && r.id != null) {
          store[String(r.id)] = (r.value == null ? null : String(r.value));
          known[String(r.id)] = true;
        }
      });

      var hasMain = (DB_KEY in store) && store[DB_KEY] != null;
      if (hasMain) {
        if (bootSawEmpty && !dbKeyWritten && !alreadyReloaded) {
          try {
            window.name = 'llShimReloaded=1';
            location.reload();
          } catch (e) {}
        }
      }
    }

    function onPreloadError(e) {
      preloadDone = true;
      console.warn('llShim: preload list failed', e);
    }

    try {
      var p = AiPhone.db.list(COLLECTION, { limit: 500 });
      if (p && typeof p.then === 'function') {
        p.then(onPreloadRows, onPreloadError);
      } else {
        onPreloadRows([]);
      }
    } catch (e) {
      onPreloadError(e);
    }
    return;
  }

  /* ==================================================================
   * 环境 2/3：无 window.AiPhone。先探测 /api/lifeline/sync 是否可用。
   * 同步 XHR：必须在 lifeline 主脚本执行前把主键灌进内存。探测失败 → 环境 3。
   * ================================================================== */
  var serverState = null;
  var serverUpdatedAt = 0;
  var probeOk = false;
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/lifeline/sync', false);
    xhr.send();
    if (xhr.status === 200) {
      var data = JSON.parse(xhr.responseText);
      if (data && data.ok) {
        probeOk = true;
        serverState = (typeof data.state === 'string') ? data.state : null;
        serverUpdatedAt = Number(data.updatedAt) || 0;
      }
    }
  } catch (e) {
    probeOk = false;
  }

  if (!probeOk) {
    // 环境 3：直接打开 index.html，原生 localStorage 即可用
    return;
  }

  /* ===== 环境 2：同源 float 部署，内存 Map + /api/lifeline/sync 持久层 ===== */
  var cloudStore = Object.create(null);
  var localUpdatedAt = serverUpdatedAt;   // 本地已知最新时间戳（LWW 判据）
  var uploadTimer = null;

  if (serverState != null) {
    cloudStore[DB_KEY] = serverState;
  } else if (nativeLS) {
    // 云端为空但浏览器原生 localStorage 有遗留副本 → 上传后清掉，一次性自愈迁移
    try {
      var legacy = nativeLS.getItem(DB_KEY);
      if (legacy != null) {
        cloudStore[DB_KEY] = legacy;
        var legacyAt = Date.now();
        localUpdatedAt = legacyAt;
        try {
          var up = new XMLHttpRequest();
          up.open('POST', '/api/lifeline/sync', true);
          up.setRequestHeader('Content-Type', 'application/json');
          up.send(JSON.stringify({ state: legacy, updatedAt: legacyAt }));
        } catch (upErr) { console.warn('llShim: legacy upload failed', upErr); }
        try { nativeLS.removeItem(DB_KEY); } catch (rmErr) {}
      }
    } catch (legacyErr) { /* 忽略 */ }
  }

  function pushToCloud() {
    var value = cloudStore[DB_KEY];
    if (value == null) return;
    var at = Date.now();
    localUpdatedAt = at;
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/lifeline/sync', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () {
        if (x.status < 200 || x.status >= 300) {
          console.warn('llShim: lifeline sync failed', x.status);
          return;
        }
        try {
          var resp = JSON.parse(x.responseText);
          if (resp && resp.ok && typeof resp.updatedAt === 'number') {
            localUpdatedAt = resp.updatedAt;
          } else if (resp && resp.conflict && typeof resp.state === 'string') {
            // 服务端版本更新：直接用服务端数据重载，让 lifeline 重新读
            cloudStore[DB_KEY] = resp.state;
            localUpdatedAt = Number(resp.updatedAt) || localUpdatedAt;
            location.reload();
          }
        } catch (e) { /* 忽略 */ }
      };
      x.onerror = function () { console.warn('llShim: lifeline sync network error'); };
      x.send(JSON.stringify({ state: value, updatedAt: at }));
    } catch (e) { console.warn('llShim: lifeline sync error', e); }
  }

  function scheduleUpload() {
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = setTimeout(pushToCloud, UPLOAD_DEBOUNCE_MS);
  }

  var cloudShim = {
    getItem: function (key) {
      key = String(key);
      return (key in cloudStore) ? cloudStore[key] : null;
    },
    setItem: function (key, value) {
      key = String(key); value = String(value);
      cloudStore[key] = value;
      if (key === DB_KEY) { scheduleUpload(); }
    },
    removeItem: function (key) {
      key = String(key);
      delete cloudStore[key];
    },
    clear: function () {
      cloudStore = Object.create(null);
    },
    key: function (index) {
      var ks = Object.keys(cloudStore);
      return (index >= 0 && index < ks.length) ? ks[index] : null;
    }
  };
  Object.defineProperty(cloudShim, 'length', {
    get: function () { return Object.keys(cloudStore).length; },
    enumerable: false,
    configurable: true
  });

  try {
    window.localStorage = cloudShim;
  } catch (assignErr) {
    try {
      Object.defineProperty(window, 'localStorage', { value: cloudShim, configurable: true, writable: true });
    } catch (defineErr) {
      console.warn('llShim: cannot install cloud localStorage proxy', defineErr);
    }
  }

  /* ===== 跨端近实时：监听推送流，他端改了就重载拉新 ===== */
  try {
    if (typeof EventSource !== 'undefined') {
      var es = new EventSource('/api/push/stream');
      es.onmessage = function (ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg && msg.type === 'lifeline_sync' &&
              typeof msg.updatedAt === 'number' && msg.updatedAt > localUpdatedAt) {
            location.reload();
          }
        } catch (e) { /* 非 JSON / 心跳注释，忽略 */ }
      };
      es.onerror = function () { /* EventSource 自带重连，不处理 */ };
    }
  } catch (e) { console.warn('llShim: sse listen failed', e); }

  window.__llFloatBridge = true;
  window.__llShimReady = {
    isReady: function () { return true; },
    getCollection: COLLECTION,
    isFloatEnv: true
  };
})();
