import { NextRequest } from "next/server";
import { extract } from "@/lib/extractor";
import type { MediaType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/**
 * Refresh the source URL for a given page URL. Re-runs extraction and returns
 * a fresh source with an unused token — used by the download dialog to ensure
 * the download starts with a valid token even after the user watched the
 * preview (which can exhaust the original token on sites like streamtape that
 * rate-limit per-token usage).
 *
 * Unlike /api/extract, this endpoint does NOT save to history (it's a silent
 * refresh for download-time use).
 *
 * Request body: { url: string, preferType?: MediaType }
 * Response: { ok: boolean, source?: { url, type, filename?, label?, ext? } }
 */
export async function POST(req: NextRequest) {
  let body: { url?: string; preferType?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  const url = body.url?.trim();
  if (!url) {
    return new Response(JSON.stringify({ ok: false, error: "Missing url" }), {
      status: 400,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  const preferType = (body.preferType as MediaType | undefined) || undefined;

  try {
    // Re-extract (without saving to history — we call extract() directly, not
    // the /api/extract route which persists to the DB).
    const result = await extract(url);
    if (!result.sources.length) {
      return new Response(
        JSON.stringify({ ok: false, error: "No sources found" }),
        { status: 404, headers: { "content-type": "application/json", ...corsHeaders() } }
      );
    }

    // Prefer the requested type; fall back to the first source.
    let pick = result.sources[0];
    if (preferType) {
      const match = result.sources.find((s) => s.type === preferType);
      if (match) pick = match;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        source: {
          url: pick.url,
          type: pick.type,
          filename: pick.filename,
          label: pick.label,
          ext: pick.ext,
        },
      }),
      { status: 200, headers: { "content-type": "application/json", ...corsHeaders() } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : "Refresh failed",
      }),
      { status: 500, headers: { "content-type": "application/json", ...corsHeaders() } }
    );
  }
}
