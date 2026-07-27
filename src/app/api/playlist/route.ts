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

/** Build a proxied URL pointing back at this endpoint. */
function proxied(target: string, base: string): string {
  let abs: string;
  try {
    abs = new URL(target, base).toString();
  } catch {
    return target;
  }
  // Route everything through /api/playlist so nested playlists + segments
  // are both handled (segments stream through).
  return `/api/playlist?url=${encodeURIComponent(abs)}`;
}

function rewriteM3u8(text: string, base: string): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        if (trimmed.startsWith("#") && /URI=/.test(trimmed)) {
          return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
            return `URI="${proxied(uri, base)}"`;
          });
        }
        return line;
      }
      return proxied(trimmed, base);
    })
    .join("\n");
}

function rewriteMpd(xml: string, base: string): string {
  let out = xml.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_m, url: string) => {
    return `<BaseURL>${proxied(url.trim(), base)}</BaseURL>`;
  });
  out = out.replace(/\b(media|initialization|sourceURL|range)="([^"]+)"/g, (_m, attr: string, val: string) => {
    if (/^https?:\/\//.test(val) || val.startsWith("/api/")) return _m;
    return `${attr}="${proxied(val, base)}"`;
  });
  return out;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  let target = sp.get("url");
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

  const isM3u8 = target.toLowerCase().includes(".m3u8");
  const isMpd = target.toLowerCase().includes(".mpd");

  // Playlists are small text — fetch fully and rewrite.
  if (isM3u8 || isMpd) {
    const fetchPlaylist = async (url: string) =>
      curlFetch(url, {
        headers: { accept: "*/*", referer: new URL(url).origin + "/" },
        timeoutMs: 20000,
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
    const rewritten = isM3u8 ? rewriteM3u8(r.text, target) : rewriteMpd(r.text, target);
    return new Response(rewritten, { status: 200, headers: outHeaders });
  }

  // Binary segment / media file — stream through curl with range support.
  const range = req.headers.get("range");
  let result;
  try {
    result = await curlStream(target, { range });
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
