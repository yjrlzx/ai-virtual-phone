import fs from "node:fs";
import path from "node:path";

// 自托管模式（无 Supabase）下应用包的本地存储。
// 目录：<项目根>/data/app-market-packages/
//   - 下载路由无 Supabase 时从这里直出文件流（GET /api/app-market/local-package）
//   - 上传路由无 Supabase 时落盘到这里
// 命名约定：管理端把应用包放成 <marketId>.zip / <marketId>.html，下载按 id 查找。

export const LOCAL_PACKAGES_DIR = path.join(process.cwd(), "data", "app-market-packages");

export function ensureLocalPackagesDir(): void {
  fs.mkdirSync(LOCAL_PACKAGES_DIR, { recursive: true });
}

function safeStem(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function contentTypeForPackage(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html;charset=utf-8";
  if (lower.endsWith(".js")) return "application/javascript;charset=utf-8";
  if (lower.endsWith(".floatapp")) return "application/octet-stream";
  return "application/zip";
}

export function kindForPackage(name: string): "zip" | "html" | "floatapp" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".floatapp")) return "floatapp";
  return "zip";
}

// 仅允许访问目录内文件；拦住 ../ 与绝对路径穿越。
export function resolveLocalPackageFile(relative: string): string | null {
  const cleaned = relative.split("?")[0].split("#")[0].replace(/^[/\\]+/, "");
  if (!cleaned || cleaned.includes("..")) return null;
  const root = path.resolve(LOCAL_PACKAGES_DIR);
  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    if (fs.statSync(abs).isFile()) return abs;
  } catch {
    // fallthrough
  }
  return null;
}

// 按应用 id 在本地目录找 <id>.html / <id>.zip / <id>.floatapp
export function findLocalPackageById(id: string): { absPath: string; fileName: string } | null {
  const stem = safeStem(id);
  if (!stem) return null;
  for (const ext of [".html", ".zip", ".floatapp"]) {
    const abs = resolveLocalPackageFile(stem + ext);
    if (abs) return { absPath: abs, fileName: stem + ext };
  }
  return null;
}

// 自托管上传：落盘到本地目录，返回相对文件名与类型
export function saveLocalPackageFile(buf: Buffer, originalName: string): { fileName: string; kind: "zip" | "html" | "floatapp"; size: number } {
  ensureLocalPackagesDir();
  const lower = originalName.toLowerCase();
  const ext = lower.endsWith(".html") ? ".html" : lower.endsWith(".floatapp") ? ".floatapp" : ".zip";
  const base = safeStem(originalName.replace(/\.[^.]+$/, "")) || "app";
  const fileName = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`;
  const abs = resolveLocalPackageFile(fileName);
  if (!abs) throw new Error("invalid_package_filename");
  fs.writeFileSync(abs, buf);
  return { fileName, kind: ext === ".html" ? "html" : ext === ".floatapp" ? "floatapp" : "zip", size: buf.length };
}
