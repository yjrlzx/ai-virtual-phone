/* Life Ledger storage layer — pure ES5.
 * Memory cache + async write-through to float host db (collection 'ledger'),
 * with graceful localStorage fallback when opened in a plain browser.
 * Rows in float db:
 *   {id:'config',  value:'<json string>'}
 *   {id:'records', value:'<json string>'}
 */
(function (global) {
  'use strict';

  var HAS_AIPHONE = !!(global.AiPhone && global.AiPhone.db);
  var HAS_NETWORK = !!(global.AiPhone && global.AiPhone.network && global.AiPhone.network.fetch);
  var HAS_REALITY = !!(global.AiPhone && global.AiPhone.reality && global.AiPhone.reality.getPayments);

  var COLLECTION = 'ledger';
  var LS_PREFIX = 'lifedb_';

  var _config = null;   // object
  var _records = null;  // array
  var _ready = false;

  function logWarn(msg) {
    try { console.warn('[ledger-storage] ' + msg); } catch (e) {}
  }

  /* ---------- low level float db helpers ---------- */

  function dbGet(key) {
    if (!HAS_AIPHONE) return Promise.resolve(null);
    try {
      return global.AiPhone.db.get(COLLECTION, key).then(function (row) {
        if (row && typeof row.value === 'string') return row.value;
        return null;
      });
    } catch (e) {
      logWarn('dbGet failed: ' + e.message);
      return Promise.resolve(null);
    }
  }

  function dbPut(key, valueStr) {
    if (!HAS_AIPHONE) return Promise.resolve();
    try {
      return global.AiPhone.db.get(COLLECTION, key).then(function (row) {
        if (row) {
          return global.AiPhone.db.update(COLLECTION, key, { value: valueStr });
        }
        return global.AiPhone.db.create(COLLECTION, { id: key, value: valueStr });
      }).catch(function (e) {
        logWarn('dbPut(' + key + ') failed: ' + (e && e.message));
      });
    } catch (e) {
      logWarn('dbPut sync failed: ' + e.message);
      return Promise.resolve();
    }
  }

  function lsGet(key) {
    try {
      var raw = global.localStorage.getItem(LS_PREFIX + key);
      return raw || null;
    } catch (e) {
      return null;
    }
  }

  function lsPut(key, valueStr) {
    try {
      global.localStorage.setItem(LS_PREFIX + key, valueStr);
    } catch (e) {
      logWarn('lsPut failed: ' + e.message);
    }
  }

  function persist(key, valueStr) {
    if (HAS_AIPHONE) return dbPut(key, valueStr);
    lsPut(key, valueStr);
    return Promise.resolve();
  }

  /* ---------- public API ---------- */

  var Storage = {

    isFloat: function () { return HAS_AIPHONE; },
    hasNetwork: function () { return HAS_NETWORK; },
    hasReality: function () { return HAS_REALITY; },
    isReady: function () { return _ready; },

    init: function () {
      var pConfig, pRecords;
      if (HAS_AIPHONE) {
        pConfig = dbGet('config');
        pRecords = dbGet('records');
      } else {
        pConfig = Promise.resolve(lsGet('config'));
        pRecords = Promise.resolve(lsGet('records'));
      }
      return Promise.all([pConfig, pRecords]).then(function (res) {
        try { _config = res[0] ? JSON.parse(res[0]) : null; } catch (e) { _config = null; }
        try { _records = res[1] ? JSON.parse(res[1]) : null; } catch (e) { _records = null; }
        if (!_records) _records = [];
        _ready = true;
        return { config: _config, records: _records };
      });
    },

    getConfig: function () { return _config; },
    getRecords: function () { return _records; },

    setConfig: function (obj) {
      _config = obj || {};
      return persist('config', JSON.stringify(_config));
    },

    setRecords: function (arr) {
      _records = arr || [];
      return persist('records', JSON.stringify(_records));
    },

    /* first run: nothing persisted at all */
    isFirstRun: function () {
      var noConfig = !_config;
      var noRecords = !_records || _records.length === 0;
      return noConfig && noRecords;
    },

    /* generic network fetch through host bridge when available */
    fetch: function (opts) {
      if (HAS_NETWORK) {
        return global.AiPhone.network.fetch(opts);
      }
      // browser fallback: native fetch
      if (typeof global.fetch === 'function') {
        var headers = opts.headers || {};
        return global.fetch(opts.url, {
          method: opts.method || 'GET',
          headers: headers,
          body: opts.body || opts.data || null
        }).then(function (r) {
          return r.text().then(function (t) {
            var parsed = null;
            try { parsed = JSON.parse(t); } catch (e) {}
            return { ok: r.ok, status: r.status, statusText: r.statusText, headers: r.headers, text: t, json: parsed };
          });
        });
      }
      return Promise.reject(new Error('no network available'));
    },

    /* pull payment notifications from Huawei shell */
    getPayments: function (limit) {
      if (!HAS_REALITY) {
        return Promise.reject(new Error('reality.getPayments unavailable'));
      }
      try {
        return Promise.resolve(global.AiPhone.reality.getPayments(limit || 50));
      } catch (e) {
        return Promise.reject(e);
      }
    }
  };

  global.LedgerStorage = Storage;
})(window);
