import type { VideoSource } from "./types";
import { curlFetch } from "./curl-fetch";

/** Convert a number to a base-N string (digits 0-9a-z). */
function toBase(n: number, base: number): string {
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, base);
  let s = "";
  if (n === 0) return "0";
  while (n > 0) {
    s = digits[n % base] + s;
    n = Math.floor(n / base);
  }
  return s;
}

/**
 * Decode a dean-edwards style packed eval block:
 *   eval(function(p,a,c,k,e,d){...}('packed',base,count,'w1|w2|...',0,{}))
 * Returns the decoded source string, or null if no packer is present.
 */
export function decodePacker(text: string): string | null {
  const marker = "eval(function(p,a,c,k,e,d)";
  const idx = text.indexOf(marker);
  if (idx < 0) return null;

  // Find the .split('|') that terminates the words array.
  const splitIdx = text.indexOf(".split('|')", idx);
  if (splitIdx < 0) return null;

  // Words string is the single-quoted segment immediately before .split('|').
  let closeQ = splitIdx - 1;
  while (closeQ >= 0 && text[closeQ] !== "'") closeQ--;
  let openQ = closeQ - 1;
  while (openQ >= 0 && text[openQ] !== "'") openQ--;
  if (closeQ < 0 || openQ < 0) return null;
  const words = text.slice(openQ + 1, closeQ).split("|");

  // Before the words opening quote we have: ...',base,count,'
  const pre = text.slice(idx, openQ);
  const m = pre.match(/,(\d+),(\d+),$/);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  const count = parseInt(m[2], 10);
  if (!base || base > 36 || !count) return null;

  // The packed string is the first argument to the call, i.e. the first
  // single-quoted string after the function body's closing brace. Find that
  // brace by matching braces from the function's opening brace.
  const funcStart = text.indexOf("{", idx);
  if (funcStart < 0) return null;
  let depth = 0;
  let braceEnd = -1;
  for (let i = funcStart; i < openQ; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd < 0) return null;
  // After } we expect ( '  — find the first ' after braceEnd.
  let packedOpen = text.indexOf("'", braceEnd);
  if (packedOpen < 0 || packedOpen >= openQ) return null;
  // The packed closing quote is the last ' before ',base,count,' — but it's
  // safer to walk forward from packedOpen, respecting backslash escapes.
  let packedClose = -1;
  for (let i = packedOpen + 1; i < openQ; i++) {
    if (text[i] === "\\" ) { i++; continue; }
    if (text[i] === "'") { packedClose = i; break; }
  }
  if (packedClose < 0) return null;
  let packed = text.slice(packedOpen + 1, packedClose);
  if (!packed) return null;

  // Unescape
  packed = packed.replace(/\\'/g, "'").replace(/\\\\/g, "\\");

  // Replace tokens. c goes from count-1 down to 0; token = c.toString(base).
  const escRe = new RegExp("[.*+?^${}()|[\\]\\\\]", "g");
  const escFn = (s: string) => s.replace(escRe, "\\$&");
  for (let c = count - 1; c >= 0; c--) {
    const w = words[c];
    if (!w) continue;
    const tok = toBase(c, base);
    if (!tok) continue;
    packed = packed.replace(new RegExp("\\b" + escFn(tok) + "\\b", "g"), w);
  }
  return packed;
}

/** Resolve a protocol-relative or relative URL. */
function abs(raw: string, base: string): string | null {
  try {
    if (raw.startsWith("//")) raw = "https:" + raw;
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function classifyUrl(url: string): VideoSource["type"] {
  const u = url.toLowerCase();
  if (/\.m3u8(\?|$)/.test(u)) return "m3u8";
  if (/\.mpd(\?|$)/.test(u)) return "mpd";
  if (/\.ts(\?|$)/.test(u)) return "ts";
  if (/\.webm(\?|$)/.test(u)) return "webm";
  if (/\.mp4(\?|$)/.test(u) || /\.m4v(\?|$)/.test(u)) return "mp4";
  if (/\.mov(\?|$)/.test(u)) return "mp4";
  if (/\.mkv(\?|$)/.test(u)) return "mp4";
  return "unknown";
}

/** Whether a URL looks like a real media file (not a logo/poster/script). */
function isMediaish(url: string): boolean {
  return /\.(m3u8|mpd|ts|webm|mp4|m4v|mov|mkv)(\?|$)/i.test(url);
}

function extOf(url: string): string | undefined {
  const m = url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toLowerCase() : undefined;
}

/** Extract a quoted value from JS like  key:"value"  or  key='value'  or key=value; */
function quotedValue(haystack: string, key: string): string | null {
  const re = new RegExp(key + "\\s*[:=]\\s*[\"']([^\"']+)[\"']");
  const m = haystack.match(re);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ */
/* Site: LuluStream family (luluvdo.com, lulustream, and clones)       */
/* Uses an eval packer that decodes to jwplayer setup with sources.    */
/* ------------------------------------------------------------------ */
function extractLuluFamily(html: string, finalUrl: string): VideoSource[] | null {
  const decoded = decodePacker(html);
  if (!decoded) return null;
  const sources: VideoSource[] = [];
  // file:"https://...m3u8?..." or file:"https://...mp4"
  const fileRe = /file\s*:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(decoded)) !== null) {
    const u = m[1];
    if (/^https?:|^\/\//.test(u) && isMediaish(u)) {
      const a = abs(u, finalUrl);
      if (a) {
        const t = classifyUrl(a);
        sources.push({ url: a, type: t, ext: extOf(a), label: t === "m3u8" ? "HLS" : t.toUpperCase() });
      }
    }
  }
  // image:"..." for poster (skip, it's an image)
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: FireStream (firestream.to)                                    */
/* token-blob + POST /api/videos/{slug}/resolve -> signedVideoUrl      */
/* ------------------------------------------------------------------ */
async function extractFirestream(html: string, finalUrl: string): Promise<VideoSource[] | null> {
  // slug from URL path /e/{slug}
  const slugMatch = finalUrl.match(/\/e\/([^/?#]+)/);
  if (!slugMatch) return null;
  const slug = slugMatch[1];
  const origin = new URL(finalUrl).origin;

  // Hint: is the encoded path an HLS manifest?
  const isHlsHint = /"encodedPath"\s*:\s*"[^"]*\.m3u8"/.test(html);

  const buildSource = (u: string): VideoSource => {
    const t = classifyUrl(u);
    const type = isHlsHint && t === "mp4" ? "m3u8" : t === "unknown" ? "mp4" : t;
    return {
      url: u,
      type,
      ext: extOf(u),
      label: isHlsHint ? "HLS" : type.toUpperCase(),
      quality: isHlsHint ? "HLS" : undefined,
    };
  };

  // The one-time resolve token is bound to the requester's IP. The sandbox
  // may route consecutive connections through different source IPs, so retry
  // the whole page-fetch + resolve a few times until the pair shares an IP.
  let currentHtml = html;
  for (let attempt = 0; attempt < 4; attempt++) {
    const blobMatch = currentHtml.match(/id=["']token-blob["'][^>]*>([^<]+)</);
    if (!blobMatch) return null;
    const blob = blobMatch[1].trim();
    try {
      const r = await curlFetch(`${origin}/api/videos/${encodeURIComponent(slug)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ blob }),
        headers: { "content-type": "application/json", referer: finalUrl },
        timeoutMs: 15000,
      });
      if (r.ok) {
        let data: { signedVideoUrl?: string } = {};
        try { data = JSON.parse(r.text); } catch { return null; }
        if (data.signedVideoUrl) return [buildSource(data.signedVideoUrl)];
      }
      // 403 "different IP" → re-fetch the page for a fresh token and retry.
    } catch {
      // network error → retry
    }
    // Re-fetch the page for the next attempt.
    try {
      const pg = await curlFetch(finalUrl, { timeoutMs: 20000 });
      currentHtml = pg.text;
    } catch {
      return null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Site: Odysseusa family (odysseusa.cc and clones) + Vidara embeds    */
/* POST {origin}/api/stream {filecode, device} -> streaming_url (m3u8) */
/* ------------------------------------------------------------------ */
async function extractOdysseusa(filecode: string, origin: string, referer: string): Promise<VideoSource[] | null> {
  try {
    const r = await curlFetch(`${origin}/api/stream`, {
      method: "POST",
      body: JSON.stringify({ filecode, device: "web" }),
      headers: { "content-type": "application/json", referer },
      timeoutMs: 15000,
    });
    if (!r.ok) return null;
    let data: { streaming_url?: string; title?: string; thumbnail?: string } = {};
    try { data = JSON.parse(r.text); } catch { return null; }
    if (!data.streaming_url) return null;
    const u = data.streaming_url;
    const t = classifyUrl(u);
    return [
      {
        url: u,
        type: t,
        ext: extOf(u),
        label: t === "m3u8" ? "HLS" : t.toUpperCase(),
        quality: t === "m3u8" ? "HLS" : undefined,
      },
    ];
  } catch {
    return null;
  }
}

/** Vidara.to embeds an iframe to an odysseusa-style host. */
async function extractVidara(html: string, finalUrl: string): Promise<VideoSource[] | null> {
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+\/e\/[^"']+)["']/i);
  if (!iframeMatch) return null;
  const iframeUrl = abs(iframeMatch[1], finalUrl);
  if (!iframeUrl) return null;
  let iframeOrigin: string;
  try {
    iframeOrigin = new URL(iframeUrl).origin;
  } catch {
    return null;
  }
  const fcMatch = iframeUrl.match(/\/e\/([^/?#]+)/);
  if (!fcMatch) return null;
  return extractOdysseusa(fcMatch[1], iframeOrigin, iframeUrl);
}

/* ------------------------------------------------------------------ */
/* Site: Playmate (playmate.to)                                        */
/* JS SPA — /watch/{filecode} has no sources in HTML.                  */
/* GET /api/download?filecode={id} -> {download_url, title, size, ...} */
/* GET /api/video-meta?filecode={id} -> {title, uploader, ...}         */
/* The CDN (sd1.playmate.to) needs referer: https://playmate.to/       */
/* ------------------------------------------------------------------ */
async function extractPlaymate(finalUrl: string): Promise<VideoSource[] | null> {
  const fcMatch = finalUrl.match(/\/watch\/([^/?#]+)/);
  if (!fcMatch) return null;
  const filecode = fcMatch[1];
  const origin = new URL(finalUrl).origin;

  // Fetch the direct download URL. The /api/download endpoint returns a JSON
  // object with download_url, title, size_formatted, and duration.
  let data: {
    download_url?: string;
    title?: string;
    size_formatted?: string;
    size?: number;
    duration?: string;
    success?: boolean;
  } = {};
  try {
    const r = await curlFetch(`${origin}/api/download?filecode=${encodeURIComponent(filecode)}`, {
      headers: { referer: finalUrl },
      timeoutMs: 15000,
    });
    if (r.ok) data = JSON.parse(r.text);
  } catch {
    return null;
  }
  if (!data.download_url) return null;

  const u = data.download_url;
  const t = classifyUrl(u);
  // Build a useful label: "MP4 · 16.19 MB · 1:19"
  const parts: string[] = [t.toUpperCase()];
  if (data.size_formatted) parts.push(data.size_formatted);
  if (data.duration) {
    // Trim leading zeros for readability: 00:01:19 -> 1:19
    const dur = data.duration.replace(/^00:(?=\d{2}:)/, "").replace(/^0(?=\d:)/, "");
    parts.push(dur);
  }

  return [
    {
      url: u,
      type: t,
      ext: extOf(u),
      label: parts.join(" · "),
      size: data.size_formatted,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Site: MixDrop (miiiixdrop.net, mixdrop.to, mixdrop.top)             */
/* /f/{id} page has iframe -> /e/{id}; embed page has packer -> wurl   */
/* ------------------------------------------------------------------ */
async function extractMixdrop(html: string, finalUrl: string): Promise<VideoSource[] | null> {
  // Find the embed iframe: /e/{id}
  let embedUrl: string | null = null;
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+\/e\/[^"']+)["']/i);
  if (iframeMatch) {
    embedUrl = abs(iframeMatch[1], finalUrl);
  }
  // If the URL itself is an /e/ page, use it directly.
  if (!embedUrl && /\/e\/[^/?#]/.test(finalUrl)) {
    embedUrl = finalUrl;
  }
  if (!embedUrl) return null;

  let embedHtml = html;
  if (embedUrl !== finalUrl) {
    try {
      const r = await curlFetch(embedUrl, {
        headers: { referer: finalUrl },
        timeoutMs: 15000,
      });
      embedHtml = r.text;
    } catch {
      return null;
    }
  }

  const decoded = decodePacker(embedHtml);
  const haystack = decoded || embedHtml;
  // MDCore.wurl="//host/.../id.mp4?..."
  const wurlMatch = haystack.match(/wurl\s*=\s*["']([^"']+)["']/);
  if (!wurlMatch) return null;
  let u = wurlMatch[1];
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:/.test(u)) {
    const a = abs(u, embedUrl);
    if (!a) return null;
    u = a;
  }
  const t = classifyUrl(u);
  // Also grab poster if present.
  const sources: VideoSource[] = [
    { url: u, type: t, ext: extOf(u), label: t.toUpperCase() },
  ];
  return sources;
}

/* ------------------------------------------------------------------ */
/* Site: Streamtape (streamtape.com)                                   */
/* Page has a robotlink/norobotlink div with /get_video?id=...&token=  */
/* ------------------------------------------------------------------ */
function extractStreamtape(html: string, finalUrl: string): VideoSource[] | null {
  // The div content looks like: /streamtape.com/get_video?id=XXX&expires=..&ip=..&token=..
  // JS builds "https:" + content. We reconstruct the canonical URL.
  const m = html.match(/get_video\?id=[^"'<\s]+&expires=[^"'<\s]+&ip=[^"'<\s]+&token=[^"'<\s]+/i);
  if (!m) return null;
  const path = m[0];
  // Origin is https://streamtape.com (or the mirror's host).
  let origin = "https://streamtape.com";
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    // keep default
  }
  const u = `${origin}/${path}`;
  return [{ url: u, type: "mp4", ext: "mp4", label: "MP4" }];
}

/* ------------------------------------------------------------------ */
/* Site: DoodStream (doodstream.com, dood.so, doodstream.watch, etc.)  */
/* Embed page has a packer or inline JS with MDCore.wurl = hls+mp4 URL  */
/* Sometimes the URL is obfuscated via a string-replace in JS.          */
/* ------------------------------------------------------------------ */
async function extractDoodstream(html: string, finalUrl: string): Promise<VideoSource[] | null> {
  // Doodstream embed pages expose MDCore.{wurl,hls} after a packer or in plain JS.
  const decoded = decodePacker(html);
  const haystack = decoded || html;
  const sources: VideoSource[] = [];

  // Look for both wurl (mp4) and hls (m3u8) keys.
  const reWurl = /MDCore\.wurl\s*=\s*["']([^"']+)["']/;
  const reHls = /MDCore\.hls\s*=\s*["']([^"']+)["']/;
  const mW = haystack.match(reWurl);
  const mH = haystack.match(reHls);

  const add = (raw: string) => {
    let u = raw;
    // Doodstream sometimes returns a host-less path; prepend origin.
    if (u.startsWith("//")) u = "https:" + u;
    else if (u.startsWith("/")) u = new URL(finalUrl).origin + u;
    if (!/^https?:/.test(u)) {
      const a = abs(u, finalUrl);
      if (!a) return;
      u = a;
    }
    const t = classifyUrl(u);
    if (t === "unknown") return;
    sources.push({ url: u, type: t, ext: extOf(u), label: t === "m3u8" ? "HLS" : t.toUpperCase() });
  };
  if (mW) add(mW[1]);
  if (mH) add(mH[1]);

  // Fallback: many dood pages also embed dsplayer with sources: [{file:"..."}]
  if (!sources.length) {
    const fileRe = /(?:file|src)\s*:\s*["']([^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(haystack)) !== null) {
      add(m[1]);
    }
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: StreamWish / Swhoi / FileLions (streamwish.to, swhoi.com,     */
/*   filelions.com, filelions.to, etc.) — packer → m3u8 + mp4 sources.  */
/* ------------------------------------------------------------------ */
function extractStreamwishFamily(html: string, finalUrl: string): VideoSource[] | null {
  const decoded = decodePacker(html);
  const haystack = decoded || html;
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // Common in streamwish: sources:[{file:"...m3u8",label:"720p"},{file:"...mp4"}]
  // or jwplayer setup with file:"..." + image:"...".
  const sourcesBlockRe = /sources\s*:\s*\[([^\]]+)\]/gi;
  let sb: RegExpExecArray | null;
  while ((sb = sourcesBlockRe.exec(haystack)) !== null) {
    const block = sb[1];
    const itemRe = /\{\s*(?:file|src)\s*:\s*["']([^"']+)["'](?:[^}]*?\b(?:label|quality|size)\s*:\s*["']([^"']+)["'])?/gi;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(block)) !== null) {
      const u = im[1];
      if (!isMediaish(u)) continue;
      const a = abs(u, finalUrl);
      if (!a || seen.has(a)) continue;
      seen.add(a);
      const t = classifyUrl(a);
      sources.push({
        url: a,
        type: t,
        ext: extOf(a),
        label: im[2] || (t === "m3u8" ? "HLS" : t.toUpperCase()),
        quality: im[2] || undefined,
      });
    }
  }

  // Fallback: bare file:"..." assignments (single-source jwplayer setups).
  if (!sources.length) {
    const fileRe = /file\s*:\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(haystack)) !== null) {
      const u = m[1];
      if (!isMediaish(u)) continue;
      const a = abs(u, finalUrl);
      if (!a || seen.has(a)) continue;
      seen.add(a);
      const t = classifyUrl(a);
      sources.push({ url: a, type: t, ext: extOf(a), label: t === "m3u8" ? "HLS" : t.toUpperCase() });
    }
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: FileMoon / MoonQ (filemoon.sx, moonq.com, etc.)                */
/* Pack-style: eval packer → m3u8 source + poster. Some clones expose   */
/* sources:[{file:"...m3u8",label:"1080p"}] after packer decode.        */
/* ------------------------------------------------------------------ */
function extractFilemoon(html: string, finalUrl: string): VideoSource[] | null {
  const decoded = decodePacker(html);
  const haystack = decoded || html;
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // Look for sources:[{file:"...",label:"..."}] like streamwish.
  const sourcesBlockRe = /sources\s*:\s*\[([^\]]+)\]/gi;
  let sb: RegExpExecArray | null;
  while ((sb = sourcesBlockRe.exec(haystack)) !== null) {
    const block = sb[1];
    const itemRe = /\{\s*(?:file|src)\s*:\s*["']([^"']+)["'](?:[^}]*?\b(?:label|quality|size)\s*:\s*["']([^"']+)["'])?/gi;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(block)) !== null) {
      const u = im[1];
      if (!isMediaish(u)) continue;
      const a = abs(u, finalUrl);
      if (!a || seen.has(a)) continue;
      seen.add(a);
      const t = classifyUrl(a);
      sources.push({
        url: a,
        type: t,
        ext: extOf(a),
        label: im[2] || (t === "m3u8" ? "HLS" : t.toUpperCase()),
        quality: im[2] || undefined,
      });
    }
  }

  // Fallback: file:"...m3u8" bare assignment.
  if (!sources.length) {
    const fileRe = /file\s*:\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(haystack)) !== null) {
      const u = m[1];
      if (!isMediaish(u)) continue;
      const a = abs(u, finalUrl);
      if (!a || seen.has(a)) continue;
      seen.add(a);
      const t = classifyUrl(a);
      sources.push({ url: a, type: t, ext: extOf(a), label: t === "m3u8" ? "HLS" : t.toUpperCase() });
    }
  }
  return sources.length ? sources : null;
}

/** Host-based dispatch. Returns sources or null to fall back to generic. */
export async function trySiteExtractor(
  html: string,
  finalUrl: string,
  host: string
): Promise<VideoSource[] | null> {
  let sources: VideoSource[] | null = null;
  try {
    if (host.includes("luluvdo") || host.includes("lulustream") || host.includes("luluvid")) {
      sources = extractLuluFamily(html, finalUrl);
    } else if (host.includes("firestream")) {
      sources = await extractFirestream(html, finalUrl);
    } else if (host.includes("playmate")) {
      sources = await extractPlaymate(finalUrl);
    } else if (host.includes("vidara")) {
      sources = await extractVidara(html, finalUrl);
    } else if (host.includes("odysseusa")) {
      const fc = finalUrl.match(/\/e\/([^/?#]+)/);
      if (fc) sources = await extractOdysseusa(fc[1], new URL(finalUrl).origin, finalUrl);
    } else if (host.includes("mixdrop") || host.includes("miiiixdrop")) {
      sources = await extractMixdrop(html, finalUrl);
    } else if (host.includes("streamtape")) {
      sources = extractStreamtape(html, finalUrl);
    } else if (host.includes("doodstream") || host.includes("dood.so") || host.includes("dood.")) {
      sources = await extractDoodstream(html, finalUrl);
    } else if (
      host.includes("streamwish") || host.includes("swhoi") ||
      host.includes("filelions") || host.includes("filelion") ||
      host.includes("streamwish.") || host.includes("embedwish")
    ) {
      sources = extractStreamwishFamily(html, finalUrl);
    } else if (host.includes("filemoon") || host.includes("moonq")) {
      sources = extractFilemoon(html, finalUrl);
    }
  } catch {
    return null;
  }
  // Attach the originating page URL so downloads can refresh expired tokens.
  if (sources && sources.length) {
    for (const s of sources) {
      if (!s.pageUrl) s.pageUrl = finalUrl;
    }
  }
  return sources;
}

export { quotedValue };
