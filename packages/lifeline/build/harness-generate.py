# -*- coding: utf-8 -*-
"""
harness-generate.py
生成 build/test-harness.html：模拟 float 自定义应用宿主（最小版）。
- 按 float rewriteAssetRefs 逻辑把 zip 内被引用的资产内联为 dataURL
- 注入最小 AiPhone bridge（db.*/network.fetch/reality.getPayments/app.getManifest）
- 宿主侧最小 db 后端存本页 localStorage，预置 lifeline 模拟 state 与 ledger 数据
- 两个 iframe（sandbox="allow-scripts allow-downloads"）并列加载 lifeline 与 ledger

用法：python harness-generate.py
输出：build/test-harness.html（浏览器直接打开；也可配合本地 http 服务）
"""
import base64
import html as htmlmod
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
LIFELINE_ZIP = os.path.join(HERE, "lifeline.float.zip")
LEDGER_ZIP = os.path.join(HERE, "ledger.float.zip")
OUT = os.path.join(HERE, "test-harness.html")

MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".css": "text/css;charset=utf-8", ".js": "text/javascript;charset=utf-8",
    ".json": "application/json;charset=utf-8", ".html": "text/html;charset=utf-8",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon",
}


def load_zip(path):
    zf = zipfile.ZipFile(path)
    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    entry = zf.read(manifest["entry"]).decode("utf-8", errors="replace")
    assets = {}
    for n in zf.namelist():
        if n in ("manifest.json", manifest["entry"]):
            continue
        assets[n] = zf.read(n)
    return manifest, entry, assets


def guess_mime(path):
    lower = path.lower()
    for ext, m in MIME.items():
        if lower.endswith(ext):
            return m
    return "application/octet-stream"


def to_data_url(path, data):
    return "data:%s;base64,%s" % (guess_mime(path), base64.b64encode(data).decode("ascii"))


def rewrite_asset_refs(html_text, assets):
    """模拟 float rewriteAssetRefs：只把 HTML 中被引用的 assets 路径替换为 dataURL。"""
    refs = set()
    for m in re.finditer(r'(?:src|href)=["\'](?:\./|/)?([^"\']+)["\']', html_text):
        refs.add(m.group(1))
    for m in re.finditer(r'url\(\s*(["\']?)(?:\./|/)?([^"\')]+?)\1\s*\)', html_text):
        refs.add(m.group(2))
    next_html = html_text
    for path in refs:
        if path not in assets:
            continue
        escaped = re.escape(path)
        data_url = to_data_url(path, assets[path]).replace('"', "&quot;")
        next_html = re.sub(
            r'(src|href)=["\'](?:\./|/)?%s["\']' % escaped,
            lambda m: '%s="%s"' % (m.group(1), data_url),
            next_html,
        )
        next_html = re.sub(
            r'url\((["\']?)(?:\./|/)?%s\1\)' % escaped,
            'url("%s")' % data_url,
            next_html,
        )
    return next_html


# 注入 iframe 的最小 AiPhone bridge（与 float createCustomAppSrcDoc 注入脚本等价）
BRIDGE_SCRIPT = r"""
<script>
(function(){
  var pending = {};
  var seq = 0;
  function request(action, payload){
    var requestId = 'h_' + (++seq);
    parent.postMessage({source:'ai-phone-custom-app-frame', type:'request', requestId:requestId, action:action, payload:payload || {}}, '*');
    return new Promise(function(resolve, reject){ pending[requestId] = { resolve: resolve, reject: reject }; });
  }
  window.addEventListener('message', function(event){
    var data = event.data || {};
    if (data.source !== 'ai-phone-custom-app-host' || !data.requestId) return;
    var item = pending[data.requestId];
    if (!item) return;
    delete pending[data.requestId];
    if (data.ok) item.resolve(data.result);
    else item.reject(new Error(data.error || 'harness request failed'));
  });
  var api = {
    app: {
      getManifest: function(){ return request('app.getManifest'); },
      getCapabilities: function(){ return Promise.resolve({}); },
      getAssetUrl: function(path){ return Promise.resolve(''); }
    },
    db: {
      create: function(collection, data){ return request('db.create', { collection: collection, data: data }); },
      update: function(collection, id, patch){ return request('db.update', { collection: collection, id: id, patch: patch }); },
      get: function(collection, id){ return request('db.get', { collection: collection, id: id }); },
      list: function(collection, query){ return request('db.list', { collection: collection, query: query || {} }); },
      delete: function(collection, id){ return request('db.delete', { collection: collection, id: id }); }
    },
    network: {
      fetch: function(payload){ return request('network.fetch', payload || {}); }
    },
    reality: {
      getPayments: function(payload){ return request('reality.getPayments', payload || {}); }
    },
    on: function(){ return function(){}; },
    off: function(){ return false; }
  };
  window.AiPhone = api;
  window.AiPhoneApp = api;
})();
</script>
"""


def build_srcdoc(manifest, entry_html, assets):
    body = rewrite_asset_refs(entry_html, assets)
    base = ("<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\" />\n"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />\n"
            "<title>%s</title>\n</head>\n<body>\n%s\n</body>\n</html>" % manifest["name"]) \
        if not re.search(r"<html[\s>]", body) else body
    # bridge 插到 head 最前（与 float 一致：先于应用脚本）
    return base.replace("<head>", "<head>" + BRIDGE_SCRIPT, 1)


def esc(s):
    # srcdoc HTML 属性值：HTML 实体转义（& 与引号）。属性值里的 </script> 按
    # HTML 规范不会结束外层 script，无需额外处理。
    return htmlmod.escape(s, quote=True)


# 预置模拟数据：lifeline state（含 finances 验证数据层完好，UI 不应出现记账）、ledger 数据
SAMPLE_LIFELINE_STATE = {
    "_appVer": "v10",
    "tasks": {"2026-09-29": {"morning": [{"t": "背单词200个", "done": False, "dur": 30}],
                             "afternoon": [], "evening": []}},
    "finances": {"initial": {"wechat": 404.73, "alipay": 20845, "cash": 400},
                 "records": [{"id": "s1", "date": "2026-09-20", "type": "expense",
                              "amount": 28.8, "method": "wechat", "category": "餐饮", "note": "晚餐汉堡"}]},
    "errors": {}, "knowledge": {}, "journals": {}, "dailySummary": {}, "weeklyReview": {},
    "monthFocus": {}, "diet": {}, "water": {}, "body": [], "targetWeight": 97,
    "gut": {}, "period": {"records": {}}, "milestones": [],
    "settings": {"fontSize": "medium", "theme": "blue"},
    "profile": {"nickname": "小玉", "avatar": "", "signature": ""},
}
SAMPLE_LEDGER_CONFIG = {
    "pkgMap": {"com.tencent.mm": "wechat", "com.eg.android.AlipayGphone": "alipay"},
    "minAmount": 0, "maxAmount": 10000, "autoConfirm": True, "autoPullOnOpen": False,
    "catRules": [{"kw": "餐饭奶茶咖啡", "cat": "餐饮"}], "toastOnAuto": True,
    "monthlyBudget": 0, "initBalances": {"wechat": 404.73, "alipay": 20845, "cash": 400},
    "pending": [],
}
SAMPLE_LEDGER_RECORDS = [
    {"id": "r1", "date": "2026-09-20", "type": "expense", "amount": 28.8,
     "category": "餐饮", "note": "晚餐汉堡", "source": "wechat", "merchant": "汉堡店"},
]


def main():
    l_manifest, l_entry, l_assets = load_zip(LIFELINE_ZIP)
    g_manifest, g_entry, g_assets = load_zip(LEDGER_ZIP)
    l_srcdoc = build_srcdoc(l_manifest, l_entry, l_assets)
    g_srcdoc = build_srcdoc(g_manifest, g_entry, g_assets)

    host = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>float 自定义应用渲染测试台</title>
<style>
  body { margin:0; background:#dfe9f2; font-family:'Segoe UI','PingFang SC',sans-serif; }
  .bar { padding:10px 16px; background:#b8e0f7; font-weight:600; color:#2a5070; }
  .cols { display:flex; flex-wrap:wrap; gap:12px; padding:12px; }
  .cell { flex:1 1 360px; max-width:560px; background:#fff; border-radius:16px; overflow:hidden;
          box-shadow:0 6px 24px rgba(130,170,220,.25); }
  .cell h2 { margin:0; padding:8px 12px; font-size:14px; background:#f0f8ff; color:#44546a; }
  iframe { width:100%; height:680px; border:0; background:#f0f8ff; }
</style>
</head>
<body>
<div class="bar">float 自定义应用渲染测试台 · lifeline（去记账） / ledger（记账）</div>
<div class="cols">
  <div class="cell"><h2>Life Line（应无记账入口）</h2>
    <iframe sandbox="allow-scripts allow-downloads" src="__L_SRCDOC__"></iframe>
  </div>
  <div class="cell"><h2>Life Ledger（记账）</h2>
    <iframe sandbox="allow-scripts allow-downloads" src="__G_SRCDOC__"></iframe>
  </div>
</div>
<script>
(function(){
  var DB = '__DB_KEY__';
  function rows(){ try{ return JSON.parse(localStorage.getItem(DB) || '[]'); }catch(e){ return []; } }
  function save(rows){ localStorage.setItem(DB, JSON.stringify(rows)); }
  // 预置模拟数据
  if (!rows().length) {
    save([
      { id: 'lifeLineState_v2', value: JSON.stringify(__STATE__), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'records', value: JSON.stringify(__RECORDS__), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'config', value: JSON.stringify(__CONFIG__), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    ]);
  }
  window.addEventListener('message', function(e){
    var d = e.data || {};
    if (d.source !== 'ai-phone-custom-app-frame' || d.type !== 'request') return;
    function resp(result){ e.source.postMessage({ source:'ai-phone-custom-app-host', requestId:d.requestId, ok:true, result:result }, '*'); }
    function fail(err){ e.source.postMessage({ source:'ai-phone-custom-app-host', requestId:d.requestId, ok:false, error:String((err && err.message) || err) }, '*'); }
    var action = d.action || '', payload = d.payload || {};
    try {
      if (action === 'app.getManifest') {
        var appId = (d.appId || '').indexOf('lifeline') >= 0 ? 'lifeline' : 'ledger';
        resp({ id: appId, name: appId === 'lifeline' ? 'Life Line' : 'Life Ledger' });
        return;
      }
      if (action === 'db.list') {
        var limit = Math.max(1, Math.min(500, Number((payload.query||{}).limit) || 100) || 100);
        resp(rows().slice(0, limit)); return;
      }
      if (action === 'db.get') {
        var row = rows().filter(function(r){ return String(r.id) === String(payload.id); })[0];
        resp(row || null); return;
      }
      if (action === 'db.create') {
        var all = rows();
        var row = Object.assign({}, payload.data || {}, { id: String((payload.data||{}).id || ('rec_' + Date.now().toString(36))), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        all = all.filter(function(r){ return String(r.id) !== String(row.id); });
        all.unshift(row);
        save(all); resp(row); return;
      }
      if (action === 'db.update') {
        var all2 = rows(); var updated = null;
        all2 = all2.map(function(r){
          if (String(r.id) !== String(payload.id)) return r;
          updated = Object.assign({}, r, payload.patch || {}, { id: String(payload.id), updatedAt: new Date().toISOString() });
          return updated;
        });
        save(all2); resp(updated); return;
      }
      if (action === 'db.delete') {
        save(rows().filter(function(r){ return String(r.id) !== String(payload.id); }));
        resp(true); return;
      }
      if (action === 'network.fetch') {
        window.fetch(payload.url, { method: payload.method || 'GET', headers: payload.headers || {}, body: payload.body })
          .then(function(r){ return r.text().then(function(t){
            var json; try { json = t ? JSON.parse(t) : undefined; } catch(e) { json = undefined; }
            resp({ ok: r.ok, status: r.status, statusText: r.statusText, headers: {}, text: t, json: json });
          }); })
          .catch(function(err){ fail(err); });
        return;
      }
      if (action === 'reality.getPayments') {
        resp({ ok: true, payments: [
          { pkg: 'com.tencent.mm', amount: '28.8', merchant: '测试奶茶店', title: '微信支付成功', ts: Date.now() - 3600000 },
          { pkg: 'com.eg.android.AlipayGphone', amount: '99', merchant: '淘宝旗舰店', title: '支付宝支付成功', ts: Date.now() - 7200000 }
        ] });
        return;
      }
      resp({});
    } catch (err) { fail(err); }
  });
})();
</script>
</body>
</html>"""

    host = host.replace("__DB_KEY__", "harness_ai_phone_db_v1")
    host = host.replace("__STATE__", json.dumps(SAMPLE_LIFELINE_STATE, ensure_ascii=False))
    host = host.replace("__RECORDS__", json.dumps(SAMPLE_LEDGER_RECORDS, ensure_ascii=False))
    host = host.replace("__CONFIG__", json.dumps(SAMPLE_LEDGER_CONFIG, ensure_ascii=False))
    host = host.replace("__L_SRCDOC__", esc(l_srcdoc))
    host = host.replace("__G_SRCDOC__", esc(g_srcdoc))

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(host)
    print("harness written:", OUT)
    print("  lifeline srcdoc bytes:", len(l_srcdoc))
    print("  ledger  srcdoc bytes:", len(g_srcdoc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
