import fs from "node:fs";

import { contentTypeForPackage, findLocalPackageById, resolveLocalPackageFile } from "@/lib/server/local-market-packages";

// 自托管应用包直出：GET /api/app-market/local-package?id=<appId> 或 ?path=<文件名>
// 无 Supabase 时，download 路由把本地包 URL 指到这里，由这里流式返回文件字节。
// 前端契约不变：POST /download 拿 {url}，再 fetch(url) 读 blob。

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  let abs: string | null = null;
  let fileName = "";

  const byId = (url.searchParams.get("id") || "").trim();
  const byPath = (url.searchParams.get("path") || "").trim();

  if (byId) {
    const found = findLocalPackageById(byId);
    if (found) {
      abs = found.absPath;
      fileName = found.fileName;
    }
  } else if (byPath) {
    abs = resolveLocalPackageFile(byPath);
    fileName = byPath.split(/[\\/]/).pop() || byPath;
  }

  if (!abs) return new Response("package_not_found", { status: 404 });

  try {
    const bytes = fs.readFileSync(abs);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentTypeForPackage(fileName),
        "Content-Length": String(bytes.length),
        "Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("package_not_found", { status: 404 });
  }
}
