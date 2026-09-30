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
 *    挂载，无 window.AiPhone）：数据主源是服务端 SQLite（/api/kv/*）。
 *    这里用同步 XHR 预灌 lifeLineState_v2 进内存 Map，保证 lifeline 依赖的同步
 *    getItem 不阻塞；setItem/removeItem 后 fire-and-forget POST 到 /api/kv/set|del。
 *    失败只 console.warn，绝不抛错、不阻塞同步流程。这样 iframe 内的读写与宿主
 *    kv-db 落同一张 SQLite 表，清浏览器缓存后数据不丢。
 *
 * 3) 直接用普通浏览器打开 index.html（file:// 或静态托管，无 /api/kv）：探测失败，
 *    本脚本什么都不做，原样保留原生 localStorage，网页照常使用。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ===== 可配置常量 ===== */
  var DB_KEY = 'lifeLineState_v2';          // lifeline 主数据键
  var COLLECTION = 'lifeline';               // float 集合名（已在 [\w.-] 白名单内）

  // 提前抓住原生 localStorage 引用：后面要在替换前做一次性遗留数据迁移，
  // 也用于失败时判断。同源 iframe 里 window.localStorage 与宿主共享同一个 Storage。
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
        // 存储里已有数据，但 lifeline 此前以空数据启动过，且用户还没动过 → 刷新一次
        // 让第二次启动时同步 getItem 命中真实数据；用 window.name 防死循环
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

    // shim 一执行就发起预灌（异步）
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
   * 环境 2/3：无 window.AiPhone。先探测是否在 float Next 同源（/api/kv 可用）。
   * 用同步 XHR：必须在 lifeline 主脚本执行前把 DB_KEY 灌进内存，否则 lifeline
   * 启动时的同步 getItem 会拿到空。探测失败（file://、静态托管、API 5xx）→
   * 环境 3，什么都不做，保留原生 localStorage。
   * ================================================================== */
  var cloudValue = null;
  var cloudProbeOk = false;
  try {
    var xhr = new XMLHttpRequest();
    // async=false：同源小请求，启动时阻塞几十毫秒，换取同步读语义正确
    xhr.open('GET', '/api/kv/get?key=' + encodeURIComponent(DB_KEY), false);
    xhr.send();
    if (xhr.status === 200) {
      var data = JSON.parse(xhr.responseText);
      if (data && data.ok) {
        cloudProbeOk = true;
        cloudValue = (typeof data.value === 'string') ? data.value : null;
      }
    }
  } catch (e) {
    // 探测失败：按普通浏览器环境处理，不动原生 localStorage
    cloudProbeOk = false;
  }

  if (!cloudProbeOk) {
    // 环境 3：直接打开 index.html，原生 localStorage 即可用，不破坏它
    return;
  }

  /* ===== 环境 2：同源 float 部署，内存 Map + /api/kv 持久层 ===== */
  var cloudStore = Object.create(null);

  // 预灌主键。云端为空但浏览器原生 localStorage 里还有遗留副本（用户曾在同源下
  // 直接用过 lifeline）→ 把它上传云端后清掉，完成一次性自愈迁移。
  if (cloudValue != null) {
    cloudStore[DB_KEY] = cloudValue;
  } else if (nativeLS) {
    try {
      var legacy = nativeLS.getItem(DB_KEY);
      if (legacy != null) {
        cloudStore[DB_KEY] = legacy;
        // fire-and-forget 上传；失败仅警告
        try {
          var upXhr = new XMLHttpRequest();
          upXhr.open('POST', '/api/kv/set', true);
          upXhr.setRequestHeader('Content-Type', 'application/json');
          upXhr.send(JSON.stringify({ key: DB_KEY, value: legacy }));
        } catch (upErr) { console.warn('llShim: legacy cloud upload failed', upErr); }
        try { nativeLS.removeItem(DB_KEY); } catch (rmErr) {}
      }
    } catch (legacyErr) { /* 读遗留失败忽略 */ }
  }

  function cloudPersistSet(key, value) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/kv/set', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () {
        if (x.status < 200 || x.status >= 300) {
          console.warn('llShim: kv set failed', key, x.status);
        }
      };
      x.onerror = function () { console.warn('llShim: kv set network error', key); };
      x.send(JSON.stringify({ key: key, value: value }));
    } catch (e) { console.warn('llShim: kv set error', key, e); }
  }

  function cloudPersistDel(key) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/kv/del', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () {
        if (x.status < 200 || x.status >= 300) {
          console.warn('llShim: kv del failed', key, x.status);
        }
      };
      x.onerror = function () { console.warn('llShim: kv del network error', key); };
      x.send(JSON.stringify({ key: key }));
    } catch (e) { console.warn('llShim: kv del error', key, e); }
  }

  var cloudShim = {
    getItem: function (key) {
      key = String(key);
      return (key in cloudStore) ? cloudStore[key] : null;
    },
    setItem: function (key, value) {
      key = String(key); value = String(value);
      cloudStore[key] = value;
      cloudPersistSet(key, value);
    },
    removeItem: function (key) {
      key = String(key);
      delete cloudStore[key];
      cloudPersistDel(key);
    },
    clear: function () {
      var keys = Object.keys(cloudStore);
      cloudStore = Object.create(null);
      keys.forEach(function (k) { cloudPersistDel(k); });
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

  window.__llFloatBridge = true;
  window.__llShimReady = {
    isReady: function () { return true; },
    getCollection: COLLECTION,
    isFloatEnv: true
  };
})();
