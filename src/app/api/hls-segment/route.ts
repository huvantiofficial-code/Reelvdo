import { NextRequest } from "next/server";
import { createDecipheriv } from "crypto";
import { curlFetchBuffer } from "@/lib/curl-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
    "access-control-allow-headers": "Range,Accept,Content-Type",
    "access-control-expose-headers": "Content-Length,Content-Type",
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function refererFromPage(page: string | null): string | undefined {
  if (!page) return undefined;
  try {
    return new URL(page).origin + "/";
  } catch {
    return undefined;
  }
}

async function fetchKeyBuffer(
  uri: string,
  referer?: string
): Promise<Buffer> {
  const r = await curlFetchBuffer(uri, { timeoutMs: 15000, referer });
  return r.buffer;
}

/**
 * GET /api/hls-segment?url=<segment_url>&page=<originalPage>&key=<key_url>&iv=<hex_iv>&index=<seg_index>
 *
 * Fetches a SINGLE HLS segment, decrypts it (AES-128-CBC) if a key URL is
 * provided, and returns the raw .ts bytes. Each request is short-lived
 * (one segment, typically 2–10 MB) so it never hits the server timeout —
 * even on a 1 Mbps connection the client downloads segments one at a time
 * and can retry / resume individual segments without restarting the whole
 * download.
 *
 * Query params:
 *   url   — the segment URL (required)
 *   page  — the original watch page URL, used to derive a hotlink referer
 *   key   — AES-128 key URL (optional, for encrypted segments)
 *   iv    — AES-128 IV in hex (optional; defaults to segment index big-endian)
 *   index — segment index (1-based, used as IV default; defaults to 1)
 *
 * Returns the raw bytes with content-type video/mp2t, or a JSON error.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const segUrl = sp.get("url");
  const page = sp.get("page");
  const keyUrl = sp.get("key");
  const ivHex = sp.get("iv");
  const indexStr = sp.get("index");
  const index = indexStr ? parseInt(indexStr, 10) : 1;

  if (!segUrl) {
    return new Response(JSON.stringify({ error: "Missing url" }), {
      status: 400,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  const referer = refererFromPage(page);

  // Fetch the segment, retrying once on transient failure. Each segment is
  // small so a retry is cheap and dramatically improves reliability on
  // flaky connections.
  let buf: Buffer | null = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2 && !buf; attempt++) {
    try {
      const r = await curlFetchBuffer(segUrl, { timeoutMs: 60000, referer });
      lastStatus = r.status;
      if (r.ok && r.buffer.length > 0) {
        buf = r.buffer;
      } else if (attempt === 0) {
        await new Promise((res) => setTimeout(res, 400));
      }
    } catch {
      if (attempt === 0) {
        await new Promise((res) => setTimeout(res, 400));
      }
    }
  }

  if (!buf) {
    return new Response(
      JSON.stringify({
        error: "Segment fetch failed",
        status: lastStatus,
      }),
      {
        status: 502,
        headers: { "content-type": "application/json", ...corsHeaders() },
      }
    );
  }

  // Decrypt AES-128-CBC encrypted segments if a key URL is provided.
  if (keyUrl) {
    try {
      const keyBuf = await fetchKeyBuffer(keyUrl, referer);
      let iv: Buffer;
      if (ivHex) {
        iv = Buffer.from(ivHex, "hex");
      } else {
        // Default IV: segment index as a 16-byte big-endian integer.
        iv = Buffer.alloc(16);
        iv.writeUInt32BE(index, 12);
      }
      const decipher = createDecipheriv("aes-128-cbc", keyBuf, iv);
      buf = Buffer.concat([decipher.update(buf), decipher.final()]);
    } catch {
      // Decryption failed — return raw bytes (better than failing entirely).
    }
  }

  const headers = new Headers(corsHeaders());
  headers.set("content-type", "video/mp2t");
  headers.set("content-length", String(buf.length));
  headers.set("cache-control", "no-store");
  return new Response(new Uint8Array(buf), { status: 200, headers });
}
