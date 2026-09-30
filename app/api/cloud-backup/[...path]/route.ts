// 自托管云备份文件存储：同源 cookie 鉴权，文件落服务器 data/cloud-backup/<userId>/。
// 替代原 Supabase Storage REST。路径全部做防穿越校验。
//
//   GET  /api/cloud-backup/<path>            读文件（stream）
//   GET  /api/cloud-backup/<path>?list=1     列出 <path>/ 前缀下对象（{name,size,updatedAt}[]）
//   PUT  /api/cloud-backup/<path>            写/覆盖文件
//   POST /api/cloud-backup/<path>            同上（兼容旧 client）
//   DELETE /api/cloud-backup/<path>          删除文件

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { getCurrentAccount } from "@/lib/server/account-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = resolve(process.cwd(), "data", "cloud-backup");

function userDir(userId: string): string {
  // userId 来自服务端 account，已做过鉴权；再 hash 一层避免非法字符
  const safe = createHash("sha1").update(userId).digest("hex").slice(0, 16);
  return join(ROOT, safe);
}

/** 防穿越：把 [...path] 拼成绝对路径并校验仍在该用户目录内。 */
function safeResolve(userId: string, segments: string[]): string | null {
  const base = userDir(userId);
  const normalized = (segments || []).map((s) => s.replace(/\\/g, "/")).join("/");
  if (normalized.includes("..")) return null;
  const abs = resolve(base, normalized);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

async function readRequestBlob(request: Request): Promise<Buffer> {
  const ab = await request.arrayBuffer();
  return Buffer.from(ab);
}

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { path } = await context.params;
  const target = safeResolve(account.id, path ?? []);
  if (!target) return NextResponse.json({ ok: false, error: "bad_path" }, { status: 400 });

  const url = new URL(request.url);
  const listMode = url.searchParams.get("list") === "1";

  try {
    if (listMode) {
      // 列该前缀下的文件；返回 name 相对前缀（与 Supabase 行为一致）
      const prefixDir = statSync(target).isDirectory() ? target : target;
      const out: Array<{ name: string; size: number; updatedAt: string }> = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          const st = statSync(full);
          const rel = full.slice(prefixDir.length).replace(/^[\\/]+/, "");
          out.push({ name: rel.split(sep).join("/"), size: st.size, updatedAt: st.mtime.toISOString() });
        }
      };
      try { walk(prefixDir); } catch { /* 目录不存在 = 空列表 */ }
      return NextResponse.json(out);
    }

    const st = statSync(target);
    if (!st.isFile()) return NextResponse.json({ ok: false, error: "not_file" }, { status: 400 });
    const nodeStream = createReadStream(target);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    return new Response(webStream, {
      headers: {
        "Content-Length": String(st.size),
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return writeObject(request, context);
}
export async function POST(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return writeObject(request, context);
}

async function writeObject(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { path } = await context.params;
  const target = safeResolve(account.id, path ?? []);
  if (!target) return NextResponse.json({ ok: false, error: "bad_path" }, { status: 400 });

  // 不能直接写目录
  if (target.endsWith(sep) || target.endsWith("/")) {
    return NextResponse.json({ ok: false, error: "is_directory" }, { status: 400 });
  }
  mkdirSync(join(target, ".."), { recursive: true });

  try {
    const body = await readRequestBlob(request);
    writeFileSync(target, body);
    return NextResponse.json({ ok: true, size: body.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { path } = await context.params;
  const target = safeResolve(account.id, path ?? []);
  if (!target) return NextResponse.json({ ok: false, error: "bad_path" }, { status: 400 });

  try {
    unlinkSync(target);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
