/**
 * Life Line Supabase 云同步 v34（float 沙盒适配版）
 * ------------------------------------------------------------------
 * v34 变更原因：lifeline 运行在 float 虚拟手机沙盒 iframe（srcDoc, origin=null）中，
 * 原生 window.fetch 受同源/CORS 限制不可靠。本脚本统一改用宿主桥 AiPhone.network.fetch
 * 发起请求；仅当桥不可用时才降级 window.fetch。
 *
 * 同时：float-storage-shim.js 已把 window.localStorage 替换为内存+异步回写代理，
 * 本脚本对 localStorage.setItem 的 monkey-patch 仍然生效（patch 到的是代理对象），
 * DB_KEY 写入时照常触发云端推送。
 *
 * 响应统一为 {ok,status,statusText,headers,text,json}：
 *   - 走桥时 json 已由宿主解析为对象
 *   - 降级 window.fetch 时本脚本自行解析
 * 因此下游一律读 res.json（对象）/ res.text（字符串），不要再调用 res.json() 方法。
 *
 * 打开时先从云端拉最新，再推送本地。
 * ------------------------------------------------------------------
 */
(function () {
  var DB_KEY = 'lifeLineState_v2';
  var TABLE = 'lifelinestate';
  var DEVICE_ID = 'main';
  var SB_URL = 'https://hfdggpgvfwsblyftarzm.supabase.co';
  var SB_KEY = 'sb_publishable_Osc_G8_edmeMUDQnK_sj3w_aD7iwkMa';
  var MAX_BODY = 1024 * 1024; // 推送体超过 1MB 则放弃云端推送，仅本地保存

  var isUpdatingFromCloud = false;
  var lastPushedData = '';

  function getState() {
    try { return JSON.parse(localStorage.getItem(DB_KEY) || 'null'); } catch (e) { return null; }
  }
  function headers() {
    return { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
  }
  function rest(path) {
    return SB_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + '/rest/v1/' + path;
  }

  // 统一请求入口：优先宿主桥 AiPhone.network.fetch，降级 window.fetch 并封装同构结果
  function requestFetch(url, options) {
    options = options || {};
    var method = options.method || 'GET';
    var hdrs = options.headers || {};
    var body = options.body;
    if (window.AiPhone && AiPhone.network && typeof AiPhone.network.fetch === 'function') {
      try {
        return AiPhone.network.fetch({ url: url, method: method, headers: hdrs, body: body });
      } catch (e) {
        // 桥抛错则继续降级
      }
    }
    if (typeof window.fetch === 'function') {
      return window.fetch(url, { method: method, headers: hdrs, body: body }).then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = JSON.parse(t); } catch (_) { j = null; }
          return { ok: r.ok, status: r.status, statusText: (r.statusText || ''), headers: r.headers, text: t, json: j };
        });
      });
    }
    return Promise.reject(new Error('llSync: no fetch available'));
  }

  function setStatus(text, color) {
    var dot = document.getElementById('llSyncDot');
    var txt = document.getElementById('llSyncText');
    if (dot) dot.style.background = color || '#ccc';
    if (txt) txt.textContent = text;
  }

  function createSyncButton() {
    if (document.getElementById('llSyncDot')) return;
    var btn = document.createElement('div');
    btn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:9999;background:white;border-radius:20px;padding:6px 12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;';
    btn.innerHTML = '<span id="llSyncDot" style="width:8px;height:8px;border-radius:50%;background:#ccc;"></span><span id="llSyncText">同步</span>';
    btn.onclick = function() {
      setStatus('同步中...', '#f0ad4e');
      pushLocal();
    };
    document.body.appendChild(btn);
  }

  function pushLocal() {
    var data = getState();
    if (!data) return;
    data._updatedAt = Date.now();
    var dataStr = JSON.stringify({
      deviceid: DEVICE_ID,
      statedata: data
    });
    if (dataStr === lastPushedData) return;
    lastPushedData = dataStr;

    // 体过大：放弃云端推送，仅本地保存，不阻塞页面
    if (dataStr.length > MAX_BODY) {
      setStatus('仅本地', '#888');
      return;
    }

    setStatus('同步中...', '#f0ad4e');
    requestFetch(rest(TABLE + '?on_conflict=deviceid'), {
      method: 'POST',
      headers: Object.assign(headers(), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: dataStr
    }).then(function (res) {
      if (res && res.ok) setStatus('已同步', '#5cb85c');
      else setStatus('推送失败', '#d9534f');
    }).catch(function (e) {
      setStatus('离线', '#d9534f');
    });
  }

  var origSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, val) {
    origSetItem(key, val);
    if (key === DB_KEY && !isUpdatingFromCloud) {
      pushLocal();
    }
  };

  function pullFromCloud() {
    // 每次打开都检查云端，如果云端比本地新就拉取刷新
    requestFetch(rest(TABLE + '?deviceid=eq.' + DEVICE_ID), {
      method: 'GET',
      headers: headers()
    }).then(function (res) {
      var rows = res && res.json; // 已是解析后的数组
      if (!rows || !rows.length) { init(); return; }
      var cloud = rows[0].statedata;
      if (!cloud) { init(); return; }
      var local = getState();
      var cloudTime = (cloud && cloud._updatedAt) || 0;
      var localTime = (local && local._updatedAt) || 0;
      if (cloudTime > localTime) {
        cloud._updatedAt = Date.now();
        isUpdatingFromCloud = true;
        localStorage.setItem(DB_KEY, JSON.stringify(cloud));
        isUpdatingFromCloud = false;
        location.reload();
      } else {
        init();
      }
    }).catch(function (e) { init(); });
  }

  function init() {
    createSyncButton();
    pushLocal();
    setInterval(pushLocal, 30000);
  }

  setTimeout(pullFromCloud, 800);
})();
