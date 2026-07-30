import { NextRequest } from "next/server";
import { createDecipheriv } from "crypto";
import { curlFetchBuffer } from "@/lib/curl-fetch";
import { refreshSourceUrl } from "@/lib/refresh";
import { resolveSegments, type SegInfo } from "@/lib/hls-resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
    "access-control-allow-headers": "Range,Accept,Content-Type",
    "access-control-expose-headers": "Content-Length,Content-Type,Content-Disposition",
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function fetchKey(uri: string, referer?: string): Promise<Buffer> {
  const r = await curlFetchBuffer(uri, { timeoutMs: 15000, referer });
  return r.buffer;
}

/** Derive a referer from the page param for hotlink-protected CDNs. */
function refererFromPage(page: string | null): string | undefined {
  if (!page) return undefined;
  try {
    return new URL(page).origin + "/";
  } catch {
    return undefined;
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  let target = sp.get("url");
  const name = sp.get("name") || "video";
  const page = sp.get("page");

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing url" }), {
      status: 400,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  let segments: SegInfo[] = [];
  const referer = refererFromPage(page);
  try {
    const r = await resolveSegments(target, { referer });
    segments = r.segments;
  } catch (e) {
    // Refresh the playlist URL (token may have expired / IP-bound) and retry.
    if (page) {
      const fresh = await refreshSourceUrl(page, "m3u8");
      if (fresh && fresh.url !== target) {
        target = fresh.url;
        try {
          const r2 = await resolveSegments(target, { referer });
          segments = r2.segments;
        } catch {
          return new Response(
            JSON.stringify({ error: "Could not read playlist", detail: e instanceof Error ? e.message : "" }),
            { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
          );
        }
      }
    }
    if (!segments.length) {
      return new Response(
        JSON.stringify({ error: "Could not read playlist", detail: e instanceof Error ? e.message : "" }),
        { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
      );
    }
  }

  if (!segments.length) {
    return new Response(JSON.stringify({ error: "No segments found in playlist" }), {
      status: 502,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  const keyCache = new Map<string, Buffer>();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let failedSegments = 0;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        // Fetch the segment, retrying once on failure (transient network
        // errors are common for HLS CDNs). We DO NOT inject text error
        // markers into the stream — that would corrupt the binary .ts file
        // and inflate the byte count past the size estimate. Failed segments
        // are silently skipped (the video will have a small gap there).
        let buf: Buffer | null = null;
        for (let attempt = 0; attempt < 2 && !buf; attempt++) {
          try {
            const r = await curlFetchBuffer(seg.url, { timeoutMs: 90000, referer });
            if (r.ok && r.buffer.length > 0) {
              buf = r.buffer;
            } else if (attempt === 0) {
              // Brief backoff before retry.
              await new Promise((res) => setTimeout(res, 500));
            }
          } catch {
            if (attempt === 0) {
              await new Promise((res) => setTimeout(res, 500));
            }
          }
        }
        if (!buf) {
          failedSegments++;
          continue;
        }
        // Decrypt AES-128 encrypted segments if a key is present.
        if (seg.key && seg.key.method === "AES-128") {
          try {
            let keyBuf = keyCache.get(seg.key.uri);
            if (!keyBuf) {
              keyBuf = await fetchKey(seg.key.uri, referer);
              keyCache.set(seg.key.uri, keyBuf);
            }
            let iv: Buffer;
            if (seg.key.iv) {
              iv = Buffer.from(seg.key.iv, "hex");
            } else {
              iv = Buffer.alloc(16);
              iv.writeUInt32BE(i + 1, 12);
            }
            const decipher = createDecipheriv("aes-128-cbc", keyBuf, iv);
            buf = Buffer.concat([decipher.update(buf), decipher.final()]);
          } catch {
            // Decryption failed — use raw bytes (better than skipping).
          }
        }
        try {
          controller.enqueue(new Uint8Array(buf));
        } catch {
          // Client disconnected — stop processing.
          break;
        }
      }
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  const headers = new Headers(corsHeaders());
  headers.set("content-type", "video/mp2t");
  headers.set(
    "content-disposition",
    `attachment; filename="${name.replace(/"/g, "_")}.ts"`
  );
  headers.set("cache-control", "no-store");
  return new Response(stream, { status: 200, headers });
}
