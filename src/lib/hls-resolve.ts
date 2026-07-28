import { curlFetch } from "./curl-fetch";

export interface SegInfo {
  url: string;
  key?: { method: string; uri: string; iv?: string };
  /** Optional #EXTINF duration in seconds (parsed from preceding tag). */
  duration?: number;
}

/** Recursively resolve an m3u8 (master → media playlist) into a segment list. */
export async function resolveSegments(
  startUrl: string,
  opts?: { referer?: string; depth?: number }
): Promise<{ segments: SegInfo[]; isMaster: boolean; totalDuration?: number }> {
  const depth = opts?.depth ?? 0;
  if (depth > 4) return { segments: [], isMaster: false };
  const r = await curlFetch(startUrl, {
    headers: { accept: "*/*" },
    timeoutMs: 20000,
    referer: opts?.referer,
  });
  const text = r.text;
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  let base = startUrl;
  try {
    base = new URL(startUrl).toString();
  } catch {
    // keep
  }

  let key: { method: string; uri: string; iv?: string } | undefined;
  const variants: { url: string; bandwidth: number; resolution?: string }[] = [];
  let pendingBandwidth = 0;
  let pendingRes: string | undefined;
  let pendingDuration: number | undefined;
  const segments: SegInfo[] = [];
  let isMaster = false;
  let totalDuration = 0;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY")) {
      const method = line.match(/METHOD=([A-Z0-9-]+)/i)?.[1] || "NONE";
      const uri = line.match(/URI="([^"]+)"/i)?.[1];
      const iv = line.match(/IV=0x([0-9a-fA-F]+)/i)?.[1];
      if (uri && method !== "NONE") {
        const absKey = new URL(uri, base).toString();
        key = { method, uri: absKey, iv };
      } else {
        key = undefined;
      }
    } else if (line.startsWith("#EXT-X-STREAM-INF")) {
      isMaster = true;
      const bw = line.match(/BANDWIDTH=(\d+)/i)?.[1];
      const rs = line.match(/RESOLUTION=([0-9x]+)/i)?.[1];
      pendingBandwidth = bw ? parseInt(bw, 10) : 0;
      pendingRes = rs;
    } else if (line.startsWith("#EXTINF")) {
      const m = line.match(/#EXTINF:([\d.]+)/i);
      if (m) pendingDuration = parseFloat(m[1]);
    } else if (line && !line.startsWith("#")) {
      const abs = new URL(line, base).toString();
      if (isMaster) {
        variants.push({ url: abs, bandwidth: pendingBandwidth, resolution: pendingRes });
        pendingBandwidth = 0;
        pendingRes = undefined;
      } else {
        segments.push({ url: abs, key, duration: pendingDuration });
        if (pendingDuration) totalDuration += pendingDuration;
        pendingDuration = undefined;
      }
    }
  }

  if (isMaster && variants.length) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return resolveSegments(variants[0].url, { referer: opts?.referer, depth: depth + 1 });
  }
  return { segments, isMaster, totalDuration };
}

/** HEAD a segment URL to get its byte size, falling back to a ranged GET. */
export async function segmentSize(url: string, opts?: { referer?: string; timeoutMs?: number }): Promise<number | null> {
  const timeoutMs = opts?.timeoutMs ?? 15000;
  try {
    // With -I, curl prints headers to stdout. Our curlFetch returns those
    // headers as `text`. Parse Content-Length out of them.
    const r = await curlFetch(url, {
      method: "HEAD",
      headers: { accept: "*/*" },
      timeoutMs,
      referer: opts?.referer,
    });
    if (r.status >= 200 && r.status < 300) {
      const m = r.text.match(/content-length:\s*(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
  } catch {
    // fall through
  }

  // Ranged GET fallback (1 byte). Many CDNs ignore Range but the response
  // still carries a Content-Range or Content-Length header we can parse.
  try {
    const r = await curlFetch(url, {
      headers: { range: "bytes=0-0", accept: "*/*" },
      timeoutMs,
      referer: opts?.referer,
    });
    if (r.status === 206 || r.status === 200) {
      // Content-Range: bytes 0-0/12345
      const m = r.text.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
      if (m) return parseInt(m[1], 10);
      // If 200 with no range support, Content-Length is the full size.
      const cl = r.text.match(/content-length:\s*(\d+)/i);
      if (cl) return parseInt(cl[1], 10);
    }
  } catch {
    // ignore
  }
  return null;
}

/** Sum the byte sizes of all segments (best-effort, parallel-batched).
 *
 * Returns:
 *  - `total`: measured sum of segment sizes (null if every HEAD failed).
 *  - `estimated`: duration-weighted estimate — when some segments fail to
 *    resolve, their sizes are inferred from the average bytes/second of the
 *    successfully resolved segments. Always non-null when at least one
 *    segment resolved and durations are available; equals `total` when all
 *    resolved. Lets the download dialog show a real % bar even on CDNs that
 *    block HEAD requests.
 *  - `resolved` / `failed`: counts.
 */
export async function totalSegmentBytes(
  segments: SegInfo[],
  opts?: { referer?: string; concurrency?: number }
): Promise<{
  total: number | null;
  estimated: number | null;
  resolved: number;
  failed: number;
}> {
  const concurrency = opts?.concurrency ?? 6;
  const referer = opts?.referer;
  if (segments.length === 0)
    return { total: 0, estimated: 0, resolved: 0, failed: 0 };
  let resolved = 0;
  let failed = 0;
  let total = 0;
  let anyResolved = false;
  // Track resolved (size, duration) pairs for the duration-weighted estimate.
  let resolvedDurationSum = 0;
  const failedDurations: number[] = [];

  // Process in batches to avoid hammering the CDN.
  for (let i = 0; i < segments.length; i += concurrency) {
    const batch = segments.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (s) => {
        const sz = await segmentSize(s.url, { referer });
        return { sz, dur: s.duration };
      })
    );
    for (const { sz, dur } of results) {
      if (sz === null) {
        failed++;
        if (dur && dur > 0) failedDurations.push(dur);
      } else {
        resolved++;
        total += sz;
        anyResolved = true;
        if (dur && dur > 0) resolvedDurationSum += dur;
      }
    }
  }

  // Duration-weighted estimate: infer failed segments' sizes from the average
  // bytes/second of resolved segments. Falls back to `total` when there are
  // no failed segments or no duration data to work with.
  let estimated: number | null = anyResolved ? total : null;
  if (anyResolved && failedDurations.length > 0) {
    const bytesPerSecond =
      resolvedDurationSum > 0 ? total / resolvedDurationSum : 0;
    if (bytesPerSecond > 0) {
      const inferred = failedDurations.reduce((a, d) => a + d * bytesPerSecond, 0);
      estimated = total + inferred;
    }
  }

  return { total: anyResolved ? total : null, estimated, resolved, failed };
}
