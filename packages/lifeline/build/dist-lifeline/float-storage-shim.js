/**
 * float-storage-shim.js
 * ------------------------------------------------------------------
 * lifeline 在 float 虚拟手机沙盒 iframe（srcDoc, origin=null）里运行时，
 * 原生 localStorage/sessionStorage/IndexedDB/cookie 全部不可用（访问即抛
 * SecurityError）。本脚本在 lifeline 主体脚本之前执行，把 window.localStorage
 * 替换为一个兼容代理：
 *   - 内存 Map 同步缓存（保证 lifeline 的同步 getItem/setItem 不报错）
 *   - 异步把每一项回写到宿主 AiPhone.db（collection='lifeline'，主键=storage key）
 *   - 启动时预灌内存；若发现 lifeline 已以空数据启动，则刷新一次页面让同步读命中
 *   - float 存储为空时，自动从 Supabase 云端迁移一次历史数据
 *
 * 环境降级：若 window.AiPhone 不存在（直接用普通浏览器打开），本脚本什么都不做，
 * 原样保留原生 localStorage，网页照常使用。
 *
 * 注意：本脚本必须在 sync-inject.js 之前加载（sync-inject 会 patch localStorage.setItem，
 * 它 patch 到的就是这里的代理对象）。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ===== 可配置常量（按需替换） ===== */
  var DB_KEY = 'lifeLineState_v2';          // lifeline 主数据键
  var COLLECTION = 'lifeline';               // float 集合名（已在 [\w.-] 白名单内）
  var TABLE = 'lifelinestate';              // Supabase 表名
  var DEVICE_ID = 'main';
  var SB_URL = 'https://hfdggpgvfwsblyftarzm.supabase.co';
  var SB_KEY = 'sb_publishable_Osc_G8_edmeMUDQnK_sj3w_aD7iwkMa';

  // 非 float 环境：没有宿主 bridge，直接放弃，不破坏原生 localStorage
  if (!window.AiPhone) { return; }

  /* ===== 内存状态 ===== */
  var store = Object.create(null);   // key -> string value
  var known = Object.create(null);    // key -> true（已存在于 float db）
  var preloadDone = false;            // 预灌是否已完成
  var bootSawEmpty = false;           // 预灌完成前，getItem(DB_KEY) 是否读到 null
  var dbKeyWritten = false;           // 预灌完成前是否已经 setItem(DB_KEY)（用户已操作）
  var alreadyReloaded = !!(window.name && window.name.indexOf('llShimReloaded=1') >= 0);

  /* ===== 统一网络请求：优先宿主 bridge，降级 window.fetch ===== */
  function doFetch(url, options) {
    options = options || {};
    var method = options.method || 'GET';
    var headers = options.headers || {};
    var body = options.body;
    if (window.AiPhone && AiPhone.network && typeof AiPhone.network.fetch === 'function') {
      try {
        // 宿主返回 {ok,status,statusText,headers,text,json}，json 已是解析后的对象
        return AiPhone.network.fetch({ url: url, method: method, headers: headers, body: body });
      } catch (e) {
        // 抛错则降级到 window.fetch
      }
    }
    if (typeof window.fetch === 'function') {
      return window.fetch(url, { method: method, headers: headers, body: body }).then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = JSON.parse(t); } catch (_) { j = null; }
          return { ok: r.ok, status: r.status, statusText: (r.statusText || ''), headers: r.headers, text: t, json: j };
        });
      });
    }
    return Promise.reject(new Error('llShim: no fetch available'));
  }

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

  /* ===== 云端迁移：float 存储为空时，从 Supabase 拉一次历史数据 ===== */
  function migrateFromCloud() {
    if (dbKeyWritten) { return; } // 用户已开始操作，不要覆盖
    var url = SB_URL + '/rest/v1/' + TABLE + '?deviceid=eq.' + DEVICE_ID;
    doFetch(url, {
      method: 'GET',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
    }).then(function (res) {
      if (!res || !res.ok) { throw new Error('migrate http ' + (res && res.status)); }
      var rows = res.json;
      if (!rows || !rows.length || !rows[0] || !rows[0].statedata) {
        console.warn('llShim: cloud has no data, start fresh');
        return;
      }
      var statedata = rows[0].statedata;
      var val = JSON.stringify(statedata);
      AiPhone.db.create(COLLECTION, { id: DB_KEY, value: val }).then(function () {
        console.warn('llShim: cloud migrated, reloading');
        try { location.reload(); } catch (e) {}
      }, function (e) {
        console.warn('llShim: migrate write failed', e);
      });
    }, function (e) {
      console.warn('llShim: cloud migrate request failed', e);
    });
  }

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
    } else {
      // float 存储为空 → 尝试云端迁移
      migrateFromCloud();
    }
  }

  function onPreloadError(e) {
    preloadDone = true;
    console.warn('llShim: preload list failed', e);
    // 读失败按空处理，尝试云端迁移
    migrateFromCloud();
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
})();
