import { NextRequest } from "next/server";
import { curlFetch } from "@/lib/curl-fetch";
import { curlStream } from "@/lib/curl-stream";
import { refreshSourceUrl } from "@/lib/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

/** Build a proxied URL pointing back at this endpoint, preserving the
 *  `page` param so nested fetches keep the correct hotlink referer.
 *  Pass `kind=m3u8` for sub-playlist URLs so the route knows to treat
 *  them as playlists even if the extension isn't .m3u8 (e.g. playmate.to
 *  uses .txt for HLS playlists and .css/.js/.woff/.woff2 for TS segments). */
function proxied(target: string, base: string, page?: string | null, kind?: "m3u8" | "mpd"): string {
  let abs: string;
  try {
    abs = new URL(target, base).toString();
  } catch {
    return target;
  }
  // Route everything through /api/playlist so nested playlists + segments
  // are both handled (segments stream through).
  let out = `/api/playlist?url=${encodeURIComponent(abs)}`;
  if (page) out += `&page=${encodeURIComponent(page)}`;
  if (kind) out += `&kind=${kind}`;
  return out;
}

function rewriteM3u8(text: string, base: string, page?: string | null): string {
  const lines = text.split(/\r?\n/);
  let expectingVariant = false; // after #EXT-X-STREAM-INF (sub-playlist)
  let expectingSegment = false; // after #EXTINF (media segment)
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        if (trimmed.startsWith("#EXT-X-STREAM-INF")) expectingVariant = true;
        else if (trimmed.startsWith("#EXTINF")) expectingSegment = true;
        if (trimmed.startsWith("#") && /URI=/.test(trimmed)) {
          return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
            return `URI="${proxied(uri, base, page, "m3u8")}"`;
          });
        }
        return line;
      }
      // Non-comment line: either a sub-playlist (variant) or a segment.
      if (expectingVariant) {
        expectingVariant = false;
        expectingSegment = false;
        return proxied(trimmed, base, page, "m3u8");
      }
      // Segment (or other) — stream as binary, no kind hint.
      expectingSegment = false;
      return proxied(trimmed, base, page);
    })
    .join("\n");
}

function rewriteMpd(xml: string, base: string, page?: string | null): string {
  let out = xml.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_m, url: string) => {
    return `<BaseURL>${proxied(url.trim(), base, page)}</BaseURL>`;
  });
  out = out.replace(/\b(media|initialization|sourceURL|range)="([^"]+)"/g, (_m, attr: string, val: string) => {
    if (/^https?:\/\//.test(val) || val.startsWith("/api/")) return _m;
    return `${attr}="${proxied(val, base, page)}"`;
  });
  return out;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  let target = sp.get("url");
  const page = sp.get("page");
  const kind = sp.get("kind"); // explicit hint: "m3u8" | "mpd"
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

  // Determine if this is a playlist. Priority:
  // 1. Explicit `kind` hint from caller (most reliable — set by rewriteM3u8)
  // 2. URL extension (.m3u8 / .mpd)
  // 3. Content-type sniffing after fetch (fallback for sites like playmate.to
  //    that use .txt for HLS playlists)
  const isM3u8ByExt = target.toLowerCase().includes(".m3u8");
  const isMpdByExt = target.toLowerCase().includes(".mpd");
  let isM3u8 = kind === "m3u8" || isM3u8ByExt;
  let isMpd = kind === "mpd" || isMpdByExt;

  // Derive the hotlink referer from the embedding page (if provided), so
  // CDNs that check referer (e.g. playmate's CDN) serve the file.
  let referer: string | undefined;
  if (page) {
    try {
      referer = new URL(page).origin + "/";
    } catch {
      // ignore
    }
  }

  // Playlists are small text — fetch fully and rewrite.
  if (isM3u8 || isMpd) {
    const fetchPlaylist = async (url: string) =>
      curlFetch(url, {
        headers: { accept: "*/*" },
        timeoutMs: 20000,
        referer,
      });

    let r;
    try {
      r = await fetchPlaylist(target);
    } catch (e) {
      // Refresh on failure if we have the originating page.
      if (page) {
        const fresh = await refreshSourceUrl(page, isM3u8 ? "m3u8" : "mpd");
        if (fresh && fresh.url !== target) {
          target = fresh.url;
          try {
            targetUrl = new URL(target);
            r = await fetchPlaylist(target);
          } catch {
            return new Response(
              JSON.stringify({ error: "Playlist fetch failed", detail: e instanceof Error ? e.message : "" }),
              { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
            );
          }
        }
      }
      if (!r) {
        return new Response(
          JSON.stringify({ error: "Playlist fetch failed", detail: e instanceof Error ? e.message : "" }),
          { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
        );
      }
    }

    // If the token was rejected, refresh and retry once.
    if ((!r.ok && !r.text.trim()) || (!r.ok && r.status === 403)) {
      if (page) {
        const fresh = await refreshSourceUrl(page, isM3u8 ? "m3u8" : "mpd");
        if (fresh && fresh.url !== target) {
          target = fresh.url;
          try {
            targetUrl = new URL(target);
            r = await fetchPlaylist(target);
          } catch {
            // keep previous failure
          }
        }
      }
    }

    const outHeaders = new Headers(corsHeaders());
    outHeaders.set("content-type", isM3u8 ? "application/vnd.apple.mpegurl" : "application/dash+xml");
    outHeaders.set("cache-control", "no-store");
    if (!r.ok && !r.text.trim()) {
      return new Response(JSON.stringify({ error: `Upstream ${r.status}` }), {
        status: 502,
        headers: { "content-type": "application/json", ...corsHeaders() },
      });
    }
    const rewritten = isM3u8 ? rewriteM3u8(r.text, target, page) : rewriteMpd(r.text, target, page);
    return new Response(rewritten, { status: 200, headers: outHeaders });
  }

  // Binary segment / media file — stream through curl with range support.
  const range = req.headers.get("range");
  let result;
  try {
    result = await curlStream(target, { range, referer });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Upstream fetch failed", detail: e instanceof Error ? e.message : "" }),
      { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
    );
  }
  const outHeaders = new Headers(corsHeaders());
  const ct = result.headers["content-type"];
  const cl = result.headers["content-length"];
  const cr = result.headers["content-range"];
  if (ct) outHeaders.set("content-type", ct);
  if (cl) outHeaders.set("content-length", cl);
  if (cr) outHeaders.set("content-range", cr);
  outHeaders.set("accept-ranges", "bytes");
  return new Response(result.body, { status: result.status, headers: outHeaders });
}
