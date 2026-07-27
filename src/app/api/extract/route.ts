import { NextRequest, NextResponse } from "next/server";
import { extract } from "@/lib/extractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { url?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url) {
    return NextResponse.json({ ok: false, error: "Please provide a URL" }, { status: 400 });
  }

  try {
    const result = await extract(url);
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        sources: [],
        error: e instanceof Error ? e.message : "Extraction failed",
      },
      { status: 200 }
    );
  }
}
