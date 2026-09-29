# -*- coding: utf-8 -*-
"""
verify-package.py
静态验证 build/lifeline.float.zip 是否符合 float loadCustomAppPackage 规格，
并模拟 rewriteAssetRefs 检查资产引用完整性与 katex 字体内联。

对照依据（已从 float 源码核实）：
  - lib/custom-app-storage.ts：loadCustomAppPackage、normalizeCustomAppManifest、
    MAX_ASSET_BYTES=2MB、MAX_TEXT_LENGTH=1800000
  - lib/custom-app-types.ts：CustomAppPermission 联合类型
  - components/app-market/custom-app-runner.tsx：rewriteAssetRefs 正则

用法：python verify-package.py [zip路径]
输出：验证报告（失败以非零退出码结束，并打印 FAIL 项）
"""
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
APP = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].endswith(".zip") else "lifeline"
ZIP = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith(".zip") else os.path.join(HERE, APP + ".float.zip")
EXPECTED_JS = {
    "lifeline": ["float-storage-shim.js", "sync-inject.js", "help-inject.js", "mobile-enhance.js"],
    "ledger": ["ledger-storage.js"],
}

# 与 lib/custom-app-types.ts CustomAppPermission 一致的合法权限枚举
ALLOWED_PERMISSIONS = {
    "app.data.read", "app.data.write", "app.assets.read", "app.manifest.read",
    "ai.generate", "ai.generateImage", "ai.chat", "ai.embed", "ai.classify",
    "network.fetch", "voice.tts", "voice.stt", "voice.clone", "voice.readProfiles",
    "user.profile.read", "user.persona.read", "user.preferences.read",
    "chat.read", "chat.read.background", "chat.write", "chat.sendMessage",
    "chat.sendCard", "chat.requestReply", "chat.contacts.write", "chat.tools",
    "characters.read", "characters.state.read", "characters.state.write",
    "characters.relations.read", "calendar.read", "calendar.write",
    "world.read", "world.write", "world.activate",
    "memory.readCore", "memory.readLongTerm", "memory.readShortTerm", "memory.search",
    "memory.write", "memory.suggest", "media.pick", "media.save",
    "geo.read", "geo.watch", "notifications.read", "notifications.write",
    "tasks.schedule", "ui.toast", "ui.notification", "ui.sms", "ui.call",
    "wallet.read", "wallet.pay", "bridge.send", "bridge.read", "online.play",
}

MAX_ASSET_BYTES = 2 * 1024 * 1024
MAX_ENTRY_HTML = 1800000
SUPABASE_DOMAIN = "hfdggpgvfwsblyftarzm.supabase.co"

failures = []
warnings = []


def check(cond, msg):
    if cond:
        print("  PASS:", msg)
    else:
        print("  FAIL:", msg)
        failures.append(msg)


def check_warn(cond, msg):
    if cond:
        print("  PASS:", msg)
    else:
        print("  WARN:", msg)
        warnings.append(msg)


def main():
    print("verify:", ZIP)
    if not os.path.exists(ZIP):
        print("  FAIL: zip 不存在")
        return 1

    zf = zipfile.ZipFile(ZIP)
    names = zf.namelist()

    # 1. 必需条目
    check("manifest.json" in names, "zip 根含 manifest.json")
    check("index.html" in names, "zip 根含 index.html")

    # 2. manifest 合法性
    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    check(bool(manifest.get("name")), "manifest.name 存在")
    check(bool(manifest.get("id")), "manifest.id 存在")
    check(bool(manifest.get("entry")), "manifest.entry 存在")
    check(bool(manifest.get("icon")), "manifest.icon 存在")
    check(bool(manifest.get("version")), "manifest.version 存在")

    perms = manifest.get("permissions", [])
    check(isinstance(perms, list) and len(perms) > 0, "manifest.permissions 非空")
    bad_perms = [p for p in perms if p not in ALLOWED_PERMISSIONS]
    check(not bad_perms, "permissions 全部在合法枚举内（非法: %s）" % bad_perms)
    check("app.data.read" in perms, "包含 app.data.read")
    check("app.data.write" in perms, "包含 app.data.write")

    net = manifest.get("network") or {}
    domains = net.get("allowedDomains") or []
    check(SUPABASE_DOMAIN in domains,
          "network.allowedDomains 含 Supabase 域名 %s" % SUPABASE_DOMAIN)
    if net.get("mode"):
        check(net["mode"] in ("direct", "proxy"), "network.mode 合法")

    # 3. entry 与 icon 指向存在
    entry = manifest["entry"]
    icon = manifest["icon"]
    check(entry in names, "entry(%s) 存在于 zip" % entry)
    check(icon in names, "icon(%s) 存在于 zip" % icon)
    entry_size = zf.getinfo(entry).file_size
    check(entry_size <= MAX_ENTRY_HTML,
          "entryHtml %d <= %d" % (entry_size, MAX_ENTRY_HTML))

    # 4. 资产尺寸
    oversize = [n for n in names if zf.getinfo(n).file_size > MAX_ASSET_BYTES]
    check(not oversize, "所有资产 <= 2MB（超限: %s）" % oversize)

    # 5. 模拟 rewriteAssetRefs：index.html 里所有相对 assets/* 引用都能在 zip 找到
    #    （排除外部 URL 与 dataURL——它们是数据内容或网络资源，不属于包内资产）
    html = zf.read("index.html").decode("utf-8")
    refs = set()
    for m in re.finditer(r'(?:src|href)=["\']([^"\']+)["\']', html):
        refs.add(m.group(1))
    for m in re.finditer(r'url\(\s*["\']?([^"\')]+?)["\']?\s*\)', html):
        refs.add(m.group(1))
    def is_relative(r):
        r = r.strip()
        if not r:
            return False
        if r.startswith(("file:", "http:", "https:", "data:", "#", "//", "javascript:")):
            return False
        # 资料库板块动态生成 '<a href="pdf/'+文件名 — JS 字符串前缀，非静态资产引用
        if r.startswith("pdf/"):
            return False
        return True
    missing = sorted(r for r in refs if is_relative(r) and r not in names and r != "manifest.json")
    check(not missing, "index.html 相对资产引用全部在 zip 内（缺失: %s）" % missing)

    # 6. 应用特有 JS 是否都在
    for js in EXPECTED_JS.get(APP, []):
        check(js in names, "资产 %s 存在" % js)

    # 7. katex 字体内联检查（仅 lifeline 含 katex）：zip 内 katex.min.css 不得残留 url(fonts/)
    if APP == "lifeline":
        css = zf.read("assets/katex/katex.min.css").decode("utf-8")
        leftover = re.findall(r"url\(fonts/", css)
        check(not leftover, "katex.min.css 内字体已内联（残留 %d 处）" % len(leftover))

        # 8. shim 语法粗查
        shim = zf.read("float-storage-shim.js").decode("utf-8")
        check("localStorage" in shim and "AiPhone" in shim,
              "float-storage-shim.js 内容含 localStorage 代理与 AiPhone 引用")

    if APP == "ledger":
        check("bridge.send" in perms, "ledger 包含 bridge.send（壳支付桥通道）")
        storage = zf.read("ledger-storage.js").decode("utf-8")
        check("localStorage" in storage and "AiPhone" in storage,
              "ledger-storage.js 内容含存储代理与 AiPhone 引用")
        html_ledger = zf.read("index.html").decode("utf-8")
        check("getPayments" in html_ledger or "reality" in html_ledger,
              "index.html 含 getPayments/reality 调用代码")

    print()
    if failures:
        print("RESULT: FAIL - %d 项未通过" % len(failures))
        return 1
    print("RESULT: PASS - 全部通过（warnings: %d）" % len(warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())
