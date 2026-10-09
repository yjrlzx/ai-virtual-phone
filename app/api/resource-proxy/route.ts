import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const url = req.nextUrl.searchParams.get("url");
    if (!url) return NextResponse.json({ error: "missing url" }, { status: 400 });
    try {
        const upstream = await fetch(url, {
            headers: { "User-Agent": "float-resource-proxy" },
            signal: AbortSignal.timeout(15000),
        });
        if (!upstream.ok) return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: upstream.status });
        const buf = await upstream.arrayBuffer();
        return new NextResponse(buf, {
            headers: {
                "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=3600",
            },
        });
    } catch (e: any) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
