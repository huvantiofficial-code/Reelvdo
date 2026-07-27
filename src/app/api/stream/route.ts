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

async function fetchKey(uri: string): Promise<Buffer> {
  const r = await curlFetchBuffer(uri, { timeoutMs: 15000 });
  return r.buffer;
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
  try {
    const r = await resolveSegments(target);
    segments = r.segments;
  } catch (e) {
    // Refresh the playlist URL (token may have expired / IP-bound) and retry.
    if (page) {
      const fresh = await refreshSourceUrl(page, "m3u8");
      if (fresh && fresh.url !== target) {
        target = fresh.url;
        try {
          const r2 = await resolveSegments(target);
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
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        try {
          const r = await curlFetchBuffer(seg.url, { timeoutMs: 90000 });
          if (!r.ok) {
            controller.enqueue(encoder.encode(`\n[segment ${i + 1} failed: ${r.status}]\n`));
            continue;
          }
          let buf = r.buffer;
          if (seg.key && seg.key.method === "AES-128") {
            try {
              let keyBuf = keyCache.get(seg.key.uri);
              if (!keyBuf) {
                keyBuf = await fetchKey(seg.key.uri);
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
              // write raw on failure
            }
          }
          controller.enqueue(new Uint8Array(buf));
        } catch {
          controller.enqueue(encoder.encode(`\n[segment ${i + 1} error]\n`));
        }
      }
      controller.close();
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
