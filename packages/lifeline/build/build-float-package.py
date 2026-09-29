# -*- coding: utf-8 -*-
"""
build-float-package.py
将 packages 下某应用目录打包成 float 可安装的自定义应用 zip。

float 打包规格（loadCustomAppPackage）：
  - zip 根含 manifest.json + entry(index.html)，其余文件作为 assets（dataURL 存储）
  - 单资产大小上限 2MB（MAX_ASSET_BYTES），入口 HTML 上限 1.8MB
  - 资产路径用正斜杠

构建流程：
  1. 拷贝 index.html / manifest.json / assets/ / 根级 js 到 build/dist-<app>（干净目录）
  2. 预处理 assets/katex/katex.min.css（若存在）：把内部 url(fonts/*.woff2) 相对引用
     内联为 data:font/woff2;base64 绝对引用，woff/ttf 替换为空引用。原因：float 会把
     整个 CSS 转成 dataURL 加载，dataURL 内部相对路径没有基准，字体将加载失败。
  3. 生成 build/<app>.float.zip

用法：
  python build-float-package.py            # 打包全部（lifeline、ledger）
  python build-float-package.py lifeline   # 只打包 lifeline
  python build-float-package.py ledger     # 只打包 ledger
输出：build/lifeline.float.zip、build/ledger.float.zip
"""
import json
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGES = os.path.normpath(os.path.join(HERE, "..", ".."))  # packages
APPS = ["lifeline", "ledger"]

MAX_ASSET_BYTES = 2 * 1024 * 1024  # 2MB，与 float MAX_ASSET_BYTES 一致


def dedupe_katex(html):
    """index.html 里 katex 引用被重复粘贴了 42 次（link+script×2 的整块重复，
    部分带 Cache-Control meta 前缀）。float 会把每个被引用资产内联成 dataURL，
    42 次重复会让 srcDoc 膨胀到 40MB 级——打包时必须只保留第一处引用。"""
    block = (
        r'(?:<meta http-equiv="Cache-Control"[^>]*>'
        r'<meta http-equiv="Pragma"[^>]*>'
        r'<meta http-equiv="Expires"[^>]*>)?'
        r'<link rel="stylesheet" href="assets/katex/katex\.min\.css">\s*'
        r'<script src="assets/katex/katex\.min\.js"></script>\s*'
        r'<script src="assets/katex/auto-render\.min\.js"></script>\s*'
    )
    matches = list(re.finditer(block, html))
    if len(matches) > 1:
        # 从后往前删除多余引用，保留第一处
        for m in reversed(matches[1:]):
            html = html[: m.start()] + html[m.end():]
    return html

def copy_tree(src, dst):
    if os.path.exists(dst):
        shutil.rmtree(dst)
    os.makedirs(dst, exist_ok=True)
    shutil.copytree(src, dst, dirs_exist_ok=True)


def inline_katex_fonts(dist_dir):
    """把 dist 里 katex.min.css 的 url(fonts/...) 内联成 dataURL，返回处理统计。"""
    css_path = os.path.join(dist_dir, "assets", "katex", "katex.min.css")
    if not os.path.exists(css_path):
        return 0, 0
    with open(css_path, "r", encoding="utf-8") as f:
        css = f.read()
    fonts_dir = os.path.join(dist_dir, "assets", "katex", "fonts")
    count = 0

    def repl(m):
        nonlocal count
        name = m.group(1)
        font_path = os.path.join(fonts_dir, name)
        if not os.path.exists(font_path):
            # 只内联 woff2；woff/ttf 源文件不存在，替换为空引用让浏览器忽略，
            # 避免 dataURL CSS 内部残留失效的相对字体路径
            return "url()"
        with open(font_path, "rb") as f:
            data = f.read()
        import base64
        b64 = base64.b64encode(data).decode("ascii")
        count += 1
        mime = "font/woff2" if name.lower().endswith(".woff2") else "font/woff"
        return "url(data:%s;base64,%s)" % (mime, b64)

    # katex.min.css 里字体引用形如 url(fonts/KaTeX_XXX.woff2)
    new_css = re.sub(r"url\(fonts/([^)]+?)\)", repl, css)
    if new_css != css:
        with open(css_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(new_css)
    return count, len(css)


def build_zip(dist_dir, out_zip):
    if os.path.exists(out_zip):
        os.remove(out_zip)
    entries = []
    for root, dirs, files in os.walk(dist_dir):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, dist_dir).replace(os.sep, "/")
            entries.append((rel, full))
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, full in sorted(entries):
            zf.write(full, rel)
    return entries


def build_app(app):
    src = os.path.join(PACKAGES, app)
    if not os.path.isdir(src):
        print("SKIP:", app, "目录不存在", src)
        return True
    if not os.path.exists(os.path.join(src, "index.html")):
        print("ERROR:", app, "缺少 index.html")
        return False
    if not os.path.exists(os.path.join(src, "manifest.json")):
        print("ERROR:", app, "缺少 manifest.json")
        return False

    dist = os.path.join(HERE, "dist-" + app)
    out_zip = os.path.join(HERE, app + ".float.zip")

    copy_tree(os.path.join(src, "assets"), os.path.join(dist, "assets"))
    for name in os.listdir(src):
        full = os.path.join(src, name)
        if os.path.isfile(full) and (name.endswith(".js") or name.endswith(".html") or name.endswith(".json")):
            shutil.copy2(full, os.path.join(dist, name))
    # katex 引用去重（仅 lifeline 有此问题）：源 index.html 保留原样，dist 副本折叠重复块
    if os.path.exists(os.path.join(dist, "index.html")):
        html_path = os.path.join(dist, "index.html")
        with open(html_path, "r", encoding="utf-8") as f:
            htxt = f.read()
        deduped = dedupe_katex(htxt)
        if deduped != htxt:
            with open(html_path, "w", encoding="utf-8", newline="") as f:
                f.write(deduped)
            print("  dedupe_katex: %d -> %d 处 katex 引用" % (htxt.count("assets/katex/katex.min.css"), deduped.count("assets/katex/katex.min.css")))

    n_fonts, css_len = inline_katex_fonts(dist)
    entries = build_zip(dist, out_zip)
    total = sum(os.path.getsize(os.path.join(dist, r)) for r, _ in entries)
    oversize = [(r, os.path.getsize(os.path.join(dist, r))) for r, _ in entries
                if os.path.getsize(os.path.join(dist, r)) > MAX_ASSET_BYTES]
    print("build ok:", app)
    print("  zip:", out_zip)
    print("  entries:", len(entries), "total_bytes:", total,
          "katex_fonts_inlined:", n_fonts)
    if oversize:
        print("  WARN oversize assets (>2MB):", oversize)
    return True


def main():
    targets = sys.argv[1:] or APPS
    ok = True
    for app in targets:
        ok = build_app(app) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
