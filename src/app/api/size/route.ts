import { NextRequest, NextResponse } from "next/server";
import { resolveSegments, totalSegmentBytes } from "@/lib/hls-resolve";
import { refreshSourceUrl } from "@/lib/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/size?url=<m3u8>&page=<originalPage>
 *
 * Resolves an HLS/DASH playlist, sums the byte sizes of all its segments
 * (via parallel HEAD requests with ranged-GET fallback), and returns the
 * total. Used by the download-progress dialog to show a real % bar for HLS
 * downloads (which otherwise have no Content-Length because /api/stream
 * concatenates segments server-side).
 *
 * Returns:
 *   { ok: true, total: number, segments: number, resolved: number, failed: number, duration: number|null }
 * or
 *   { ok: false, error: string }
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  let target = sp.get("url");
  const page = sp.get("page");

  if (!target) {
    return NextResponse.json(
      { ok: false, error: "Missing url" },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }

  let segments;
  let totalDuration: number | null = null;
  try {
    const r = await resolveSegments(target);
    segments = r.segments;
    totalDuration = r.totalDuration || null;
  } catch (e) {
    // Maybe the token expired — refresh and retry once.
    if (page) {
      const fresh = await refreshSourceUrl(page, "m3u8");
      if (fresh && fresh.url !== target) {
        target = fresh.url;
        try {
          const r2 = await resolveSegments(target);
          segments = r2.segments;
          totalDuration = r2.totalDuration || null;
        } catch (e2) {
          return NextResponse.json(
            {
              ok: false,
              error: "Could not read playlist",
              detail: e2 instanceof Error ? e2.message : "",
            },
            { status: 200, headers: { "cache-control": "no-store" } }
          );
        }
      }
    }
    if (!segments) {
      return NextResponse.json(
        {
          ok: false,
          error: "Could not read playlist",
          detail: e instanceof Error ? e.message : "",
        },
        { status: 200, headers: { "cache-control": "no-store" } }
      );
    }
  }

  if (!segments || segments.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No segments found" },
      { status: 200, headers: { "cache-control": "no-store" } }
    );
  }

  try {
    const { total, estimated, resolved, failed } = await totalSegmentBytes(segments);
    return NextResponse.json(
      {
        ok: true,
        total,
        // Duration-weighted estimate — non-null whenever at least one segment
        // resolved. The download dialog uses this when `total` is null (i.e.
        // some HEAD requests failed) so the progress bar can still show a %.
        estimated,
        segments: segments.length,
        resolved,
        failed,
        duration: totalDuration,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Size check failed",
      },
      { status: 200, headers: { "cache-control": "no-store" } }
    );
  }
}
