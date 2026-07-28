import { NextRequest } from "next/server";
import { curlStream } from "@/lib/curl-stream";
import { refreshSourceUrl } from "@/lib/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
    "access-control-allow-headers": "Range,Accept,Content-Type",
    "access-control-expose-headers": "Content-Range,Content-Length,Accept-Ranges,Content-Type",
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function streamUrl(
  target: string,
  range: string | null,
  referer?: string
): Promise<{ status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> }> {
  const r = await curlStream(target, { range, referer });
  return { status: r.status, headers: r.headers, body: r.body };
}

/** Derive a referer to send to the target CDN. Many video CDNs use hotlink
 *  protection and only serve when the referer matches the embedding page's
 *  origin. When the caller passes `?page=<watch-url>`, use that page's origin;
 *  otherwise fall back to the target's own origin (curl-stream default). */
function refererFromPage(page: string | null): string | undefined {
  if (!page) return undefined;
  try {
    return new URL(page).origin + "/";
  } catch {
    return undefined;
  }
}

/** Detect "soft 403" responses where the upstream returns HTTP 200 with a
 *  text/html or JSON body (instead of the expected video/audio bytes) because
 *  the token was rate-limited or invalidated. Streamtape in particular returns
 *  `{"status":403,"msg":"Access Denied"}` with HTTP 200 + content-type
 *  text/html when the same token is used too many times. */
function isSoftBlocked(
  target: string,
  status: number,
  headers: Record<string, string>
): boolean {
  if (status < 200 || status >= 300) return false;
  const ct = (headers["content-type"] || "").toLowerCase();
  // If the response is text/html or application/json for a URL that should
  // return video/audio bytes, it's almost certainly a soft-block error page.
  if (!ct.startsWith("text/html") && !ct.startsWith("application/json")) {
    return false;
  }
  // Only treat as soft-block if the target is a known video endpoint.
  const t = target.toLowerCase();
  return (
    t.includes("get_video") || // streamtape
    t.includes("/get_video") ||
    t.endsWith(".mp4") ||
    t.endsWith(".m4v") ||
    t.endsWith(".webm") ||
    t.endsWith(".mkv") ||
    t.includes(".mp4?") ||
    t.includes(".m4v?") ||
    t.includes(".webm?")
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  let target = sp.get("url");
  const download = sp.get("download") === "1";
  const filename = sp.get("name");
  const page = sp.get("page");

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing url" }), {
      status: 400,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid url" }), {
      status: 400,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  const range = req.headers.get("range");
  const referer = refererFromPage(page);

  let result;
  try {
    result = await streamUrl(target, range, referer);
  } catch (e) {
    // If the fetch itself threw and we have a refresh page, try once.
    if (page) {
      const fresh = await refreshSourceUrl(page, "mp4");
      if (fresh && fresh.url !== target) {
        target = fresh.url;
        try {
          targetUrl = new URL(target);
          result = await streamUrl(target, range, referer);
        } catch {
          return new Response(
            JSON.stringify({ error: "Upstream fetch failed", detail: e instanceof Error ? e.message : "" }),
            { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
          );
        }
      }
    }
    if (!result) {
      return new Response(
        JSON.stringify({ error: "Upstream fetch failed", detail: e instanceof Error ? e.message : "" }),
        { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
      );
    }
  }

  // If the CDN rejected the token with a hard 403/401, refresh and retry.
  if ((result.status === 403 || result.status === 401) && page) {
    try {
      result.body.cancel?.();
    } catch {
      // ignore
    }
    const fresh = await refreshSourceUrl(page, "mp4");
    if (fresh && fresh.url !== target) {
      target = fresh.url;
      try {
        targetUrl = new URL(target);
        result = await streamUrl(target, range, referer);
      } catch {
        // keep original failure
      }
    }
  }

  // Detect "soft 403": HTTP 200 + text/html body for a video URL (streamtape's
  // rate-limited token response). Refresh the token and retry once.
  if (isSoftBlocked(target, result.status, result.headers) && page) {
    try {
      result.body.cancel?.();
    } catch {
      // ignore
    }
    const fresh = await refreshSourceUrl(page, "mp4");
    if (fresh && fresh.url !== target) {
      target = fresh.url;
      try {
        targetUrl = new URL(target);
        result = await streamUrl(target, range, referer);
      } catch {
        // keep original failure
      }
    }
  }

  const respHeaders = new Headers(corsHeaders());
  const ct = result.headers["content-type"];
  const cl = result.headers["content-length"];
  const cr = result.headers["content-range"];
  const ar = result.headers["accept-ranges"];
  if (ct) respHeaders.set("content-type", ct);
  if (cl) respHeaders.set("content-length", cl);
  if (cr) respHeaders.set("content-range", cr);
  respHeaders.set("accept-ranges", ar || "bytes");

  if (download) {
    const name =
      filename ||
      decodeURIComponent(targetUrl.pathname.split("/").pop() || "video") ||
      "video";
    respHeaders.set(
      "content-disposition",
      `attachment; filename="${name.replace(/"/g, "_")}"`
    );
  }

  return new Response(result.body, { status: result.status, headers: respHeaders });
}
