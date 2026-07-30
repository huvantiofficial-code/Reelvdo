import { NextRequest, NextResponse } from "next/server";
import { resolveSegments, segmentSize, type SegInfo } from "@/lib/hls-resolve";
import { refreshSourceUrl } from "@/lib/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/hls-segments?url=<m3u8>&page=<originalPage>
 *
 * Resolves an HLS/DASH playlist into a JSON list of segments (with URLs,
 * optional AES-128 key info, durations, and byte sizes). Used by the
 * client-side segment-by-segment downloader so each segment can be fetched
 * individually via /api/hls-segment — this avoids the long-lived streaming
 * connection of /api/stream that times out on slow connections (1 Mbps).
 *
 * Returns:
 *   { ok: true, segments: [{url, key?, iv?, duration, size}], total, duration }
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

  let referer: string | undefined;
  if (page) {
    try {
      referer = new URL(page).origin + "/";
    } catch {
      // ignore
    }
  }

  let segments: SegInfo[] = [];
  let totalDuration: number | undefined;
  try {
    const r = await resolveSegments(target, { referer });
    segments = r.segments;
    totalDuration = r.totalDuration;
  } catch (e) {
    // Maybe the token expired — refresh and retry once.
    if (page) {
      const fresh = await refreshSourceUrl(page, "m3u8");
      if (fresh && fresh.url !== target) {
        target = fresh.url;
        try {
          const r2 = await resolveSegments(target, { referer });
          segments = r2.segments;
          totalDuration = r2.totalDuration;
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
    if (!segments.length) {
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

  if (!segments.length) {
    return NextResponse.json(
      { ok: false, error: "No segments found" },
      { status: 200, headers: { "cache-control": "no-store" } }
    );
  }

  // Resolve each segment's byte size in parallel (bounded). This lets the
  // client show an accurate progress bar and total. Size resolution failures
  // are tolerated — the client falls back to duration-weighted estimates.
  const BATCH = 8;
  const out: Array<{
    url: string;
    key?: { method: string; uri: string; iv?: string };
    duration?: number;
    size: number | null;
  }> = new Array(segments.length);

  for (let i = 0; i < segments.length; i += BATCH) {
    const batch = segments.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (seg, j) => {
        let size: number | null = null;
        try {
          size = await segmentSize(seg.url, { referer, timeoutMs: 10000 });
        } catch {
          size = null;
        }
        return { idx: i + j, seg, size };
      })
    );
    for (const r of results) {
      out[r.idx] = {
        url: r.seg.url,
        key: r.seg.key,
        duration: r.seg.duration,
        size: r.size,
      };
    }
  }

  const measuredTotal = out.reduce(
    (sum, s) => (s.size != null ? sum + s.size : sum),
    0
  );
  const measuredCount = out.filter((s) => s.size != null).length;
  // Duration-weighted estimate for segments whose size couldn't be measured.
  let estimatedTotal = measuredTotal;
  if (measuredCount > 0 && measuredCount < out.length) {
    const measuredDuration = out
      .filter((s) => s.size != null && s.duration)
      .reduce((sum, s) => sum + (s.duration || 0), 0);
    const bytesPerSec =
      measuredDuration > 0 ? measuredTotal / measuredDuration : 0;
    if (bytesPerSec > 0) {
      const unmeasuredDuration = out
        .filter((s) => s.size == null && s.duration)
        .reduce((sum, s) => sum + (s.duration || 0), 0);
      estimatedTotal = measuredTotal + Math.round(bytesPerSec * unmeasuredDuration);
    }
  }

  return NextResponse.json(
    {
      ok: true,
      segments: out,
      total: measuredTotal || estimatedTotal || null,
      measured: measuredCount,
      unmeasured: out.length - measuredCount,
      duration: totalDuration || null,
      // Pass the refreshed target back so the client can use it for
      // subsequent /api/hls-segment calls (avoids re-resolving).
      playlistUrl: target,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
