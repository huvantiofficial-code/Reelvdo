import { NextRequest } from "next/server";
import { curlStream } from "@/lib/curl-stream";
import { refreshSourceUrl } from "@/lib/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1200; // 20 minutes — large video files need time

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

  // Fetch with up to 2 token-refresh retries. Many video CDNs (MixDrop's
  // mxcontent.net, StreamTape's get_video endpoint) intermittently return 403
  // due to per-IP rate-limiting or single-use tokens. On each 403/401 (or a
  // soft-block 200+text/html), re-extract a fresh token from the page URL and
  // retry, with a short backoff so the rate-limit window can clear.
  let result: { status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> } | undefined;
  let lastError: Error | undefined;
  const MAX_REFRESH_ATTEMPTS = 2;
  for (let attempt = 0; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
    try {
      result = await streamUrl(target, range, referer);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // Network-level failure (curl crashed, DNS, timeout). Try a refresh on
      // the next loop iteration if we still have attempts left and have a page.
      if (attempt < MAX_REFRESH_ATTEMPTS && page) {
        const fresh = await refreshSourceUrl(page, "mp4");
        if (fresh && fresh.url !== target) {
          target = fresh.url;
          try { targetUrl = new URL(target); } catch { /* keep */ }
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
      }
      return new Response(
        JSON.stringify({ error: "Upstream fetch failed", detail: lastError.message }),
        { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
      );
    }

    // Success or non-retryable status → stop.
    const blocked =
      result.status === 403 || result.status === 401 ||
      isSoftBlocked(target, result.status, result.headers);
    if (!blocked || !page || attempt >= MAX_REFRESH_ATTEMPTS) break;

    // The body is a ReadableStream — we need to cancel it before fetching
    // a fresh URL. Use a try/catch because the body may already be closed.
    try {
      await result.body.cancel();
    } catch { /* ignore — body may already be closed */ }
    // Clear result so we don't accidentally use the cancelled body.
    result = undefined;
    const fresh = await refreshSourceUrl(page, "mp4");
    if (!fresh || fresh.url === target) break; // no fresh token available
    target = fresh.url;
    try { targetUrl = new URL(target); } catch { /* keep */ }
    // Brief backoff to let per-IP rate-limit windows clear.
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!result) {
    // If we have a last error, return it; otherwise generic 502.
    return new Response(
      JSON.stringify({ error: "Upstream fetch failed", detail: lastError?.message || "no result after retries" }),
      { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
    );
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
