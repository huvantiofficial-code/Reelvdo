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
/*                                                                      */
/* Real flow (discovered via headless-browser network capture):        */
/*  POST /api/s  body {"c":filecode,"d":"web"}                          */
/*   -> { sx: "https://wesa231.handitrrel.com/hls/{token}/master.txt",  */
/*        ix: thumbnail, lx: language, ... }                            */
/*  The HLS playlist uses fake extensions (.txt for playlists,         */
/*  .css/.js/.woff/.woff2 for TS segments) to evade ad-blockers.       */
/*  CDN has CORS: access-control-allow-origin: * so preview works      */
/*  directly in-browser. Segments are video/mp2t.                      */
/*                                                                      */
/* The legacy /api/download URL (sd1.playmate.to) is NXDOMAIN globally */
/* and is NOT used — only the HLS stream is returned.                  */
/* ------------------------------------------------------------------ */
async function extractPlaymate(finalUrl: string): Promise<VideoSource[] | null> {
  const fcMatch = finalUrl.match(/\/watch\/([^/?#]+)/);
  if (!fcMatch) return null;
  const filecode = fcMatch[1];
  const origin = new URL(finalUrl).origin;

  // POST /api/s to get the streaming config (HLS master URL + thumbnail).
  // Use API-appropriate headers (sec-fetch-* = cors/empty, accept = json)
  // because the default curlFetch headers are browser-navigation headers
  // which playmate's API rejects with 403 "forbidden".
  let sData: {
    sx?: string; // HLS master playlist URL
    ix?: string; // thumbnail URL
    lx?: string; // language
    cx?: string; // filecode echo
    ax?: string; // ad URL
    tx?: string; // title
    kx?: string | null;
  } = {};
  try {
    const r = await curlFetch(`${origin}/api/s`, {
      method: "POST",
      body: JSON.stringify({ c: filecode, d: "web" }),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        origin,
        //referer already set below
      },
      timeoutMs: 15000,
      referer: finalUrl,
    });
    if (r.ok) sData = JSON.parse(r.text);
  } catch {
    return null;
  }
  if (!sData.sx) return null;

  const sources: VideoSource[] = [];
  // The HLS master playlist. Classify as m3u8 (HLS) since the content-type
  // is application/vnd.apple.mpegurl even though the URL ends in .txt.
  sources.push({
    url: sData.sx,
    type: "m3u8",
    ext: "m3u8",
    label: "HLS · 720p",
    quality: "720p",
    // Hint for the playlist proxy: the playlist text uses fake extensions
    // (.txt for sub-playlists, .css/.js/.woff/.woff2 for TS segments).
    // Mark as HLS so the player uses hls.js.
  });

  // Also fetch the download metadata (title, size, duration) for display.
  // We don't use the download_url itself because sd1.playmate.to is NXDOMAIN.
  try {
    const dr = await curlFetch(`${origin}/api/download?filecode=${encodeURIComponent(filecode)}`, {
      headers: { referer: finalUrl },
      timeoutMs: 10000,
    });
    if (dr.ok) {
      const dData: {
        title?: string;
        size_formatted?: string;
        size?: number;
        duration?: string;
        success?: boolean;
      } = JSON.parse(dr.text);
      // Enrich the HLS label with duration info: "HLS · 720p · 1:19"
      if (dData.duration) {
        const dur = dData.duration
          .replace(/^00:(?=\d{2}:)/, "")
          .replace(/^0(?=\d:)/, "");
        sources[0].label = `HLS · 720p · ${dur}`;
      }
      if (dData.size_formatted) sources[0].size = dData.size_formatted;
    }
  } catch {
    // Non-fatal — HLS source is still valid.
  }

  return sources;
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
/* The watch page (/v/{id}/{slug}) puts DECOY tokens in three hidden   */
/* divs (#ideoooolink, #captchalink, #norobotlink). The REAL token is  */
/* only revealed at runtime by JS that takes a quoted string literal   */
/* like 'xcdd<id>&expires=..&ip=..&token=..' and runs .substring(N)    */
/* to strip a variable-length obfuscation prefix before assigning it   */
/* back to the div's innerHTML. The static HTML tokens are decoys and  */
/* the CDN returns 403 "Access Denied" if you use them.                */
/*                                                                     */
/* The player then loads `<div_content>&stream=1` which 302-redirects  */
/* to a CDN MP4 on tapecontent.net with CORS + range support.          */
/* ------------------------------------------------------------------ */
function extractStreamtape(html: string, finalUrl: string): VideoSource[] | null {
  let origin = "https://streamtape.com";
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    // keep default
  }

  // Extract the video ID and original filename from the page URL.
  // URL pattern: /v/{id}/{slug.mp4}
  let videoId: string | null = null;
  let filename: string | null = null;
  try {
    const u = new URL(finalUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    // parts: ["v", "{id}", "{slug}"]
    if (parts.length >= 2 && parts[0] === "v") {
      videoId = parts[1];
    }
    if (parts.length >= 3 && parts[0] === "v") {
      // Slug is the original filename (URL-decoded).
      filename = decodeURIComponent(parts[2]);
    }
  } catch {
    // ignore
  }

  // STRATEGY 1 (preferred): find a JS string literal containing the real
  // &expires=X&ip=Y&token=Z triple. The static HTML decoys are NOT inside
  // quotes (they're between `>` and `</div>`), so requiring `['"]...['"]`
  // ensures we only match the JS literal with the real token.
  //
  // The literal format varies (intentional obfuscation by streamtape):
  //   'xcdd<id>&expires=..&ip=..&token=..'          (no id=, just the id value)
  //   'defg=<id>&expires=..&ip=..&token=..'         (= prefix)
  //   'xcd=<id>&expires=..&ip=..&token=..'          (= prefix)
  //   'xcddvideo?id=<id>&expires=..&ip=..&token=..' (video?id= prefix)
  //   'defg_video?id=<id>&expires=..&ip=..'         (_video?id= prefix)
  //   'xcddeo?id=<id>&expires=..&ip=..'             (deo?id= prefix)
  //
  // We don't care about the prefix — we extract expires/ip/token directly
  // and rebuild the canonical URL using the video ID from the page URL.
  const reJs = /['"][^'"]*?&expires=([^'"&<>\s]+)&ip=([^'"&<>\s]+)&token=([^'"&<>\s]+)['"]/i;
  const mJs = html.match(reJs);

  // STRATEGY 2 (fallback): old-style regex for the static HTML divs. These
  // are DECOYS on modern streamtape, but match in case the page layout
  // changes back or this is an older mirror.
  const mStatic = html.match(
    /get_video\?id=[^"'<\s]+&expires=[^"'<\s]+&ip=[^"'<\s]+&token=[^"'<\s]+/i
  );

  let url: string;
  if (mJs) {
    const expires = mJs[1];
    const ip = mJs[2];
    const token = mJs[3];
    if (!videoId) {
      // Try to recover the ID from the JS literal. The literal's first group
      // is `<junk><id>` or `<junk>?id=<id>` or `<junk>=<id>`.
      const fullLit = mJs[0];
      const idM = fullLit.match(/[?=]([A-Za-z0-9]{10,})&expires=/);
      if (idM) videoId = idM[1];
    }
    if (!videoId) return null;
    // &stream=1 makes streamtape 302-redirect to the CDN MP4 (otherwise it
    // returns 403 "Access Denied" for plain get_video calls). The CDN MP4
    // is the ORIGINAL uploaded file — no transcoding. Works for both
    // preview (range support) and download.
    url = `${origin}/get_video?id=${videoId}&expires=${expires}&ip=${ip}&token=${token}&stream=1`;
  } else if (mStatic) {
    // Strip leading "/streamtape.com/" if present, then prepend origin.
    const path = mStatic[0].replace(/^\/?streamtape\.com\//, "");
    url = `${origin}/${path}`;
    // Append &stream=1 for the same reason as above.
    url += url.includes("?") ? "&stream=1" : "?stream=1";
  } else {
    return null;
  }

  // Derive a clean label including the filename when available.
  const label = filename
    ? `MP4 · ${filename}`
    : "MP4";

  return [
    {
      url,
      type: "mp4",
      ext: "mp4",
      label,
      filename: filename || undefined,
      pageUrl: finalUrl,
    },
  ];
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

/* ------------------------------------------------------------------ */
/* Site: Morencius / VidHide family (morencius.com, vidhide.com,        */
/*   vidhidepro.com, etc.) — embed pages with eval packer that decodes  */
/*   to `var links = { hls4, hls3, hls2 }` + jwplayer setup using       */
/*   `links.hls4 || links.hls3 || links.hls2`. Used by minochinos.com   */
/*   and other "front" pages that iframe to /embed/{filecode} on a      */
/*   morencius/vidhide host.                                            */
/* ------------------------------------------------------------------ */
function extractMorenciusFamily(html: string, finalUrl: string): VideoSource[] | null {
  const decoded = decodePacker(html);
  const haystack = decoded || html;
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // The packer decodes to: var links = { hls4:"...", hls3:"...", hls2:"..." };
  // The jwplayer setup uses links.hls4 || links.hls3 || links.hls2.
  // hls2 is typically the canonical CDN master.m3u8 URL with full query
  // string (signed token). hls3 is a master.txt (fake extension) on a
  // different CDN. hls4 is a relative /stream/... URL on the embed host.
  const linksBlockMatch = haystack.match(/var\s+links\s*=\s*\{([^}]+)\}/);
  const linksBlock = linksBlockMatch ? linksBlockMatch[1] : haystack;

  // Pick out each hlsN key. Order matters: hls2 (full CDN URL) preferred.
  const pickLink = (key: string): string | null => {
    const re = new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`);
    const m = linksBlock.match(re);
    return m ? m[1] : null;
  };

  const candidates = [
    { key: "hls2", label: "HLS · CDN" },
    { key: "hls3", label: "HLS · alt CDN" },
    { key: "hls4", label: "HLS · stream" },
  ];
  for (const c of candidates) {
    const raw = pickLink(c.key);
    if (!raw) continue;
    let u = raw;
    if (u.startsWith("//")) u = "https:" + u;
    else if (u.startsWith("/")) u = new URL(finalUrl).origin + u;
    if (!/^https?:/.test(u)) {
      const a = abs(u, finalUrl);
      if (!a) continue;
      u = a;
    }
    if (seen.has(u)) continue;
    seen.add(u);
    // Some morencius pages use master.txt (HLS playlist with .txt extension
    // to evade ad-blockers). Treat any hlsN URL as m3u8 since the player
    // uses type:"hls".
    sources.push({
      url: u,
      type: "m3u8",
      ext: "m3u8",
      label: c.label,
      quality: "HLS",
    });
  }

  // Fallback: also pick up bare file:"..." assignments in the decoded JS
  // (covers older packer variants).
  if (!sources.length) {
    const fileRe = /file\s*:\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(haystack)) !== null) {
      const u = m[1];
      if (!isMediaish(u) && !/\.txt(\?|$)/i.test(u)) continue;
      const a = abs(u, finalUrl);
      if (!a || seen.has(a)) continue;
      seen.add(a);
      sources.push({
        url: a,
        type: "m3u8",
        ext: "m3u8",
        label: "HLS",
        quality: "HLS",
      });
    }
  }

  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: DoodStream clones (playmogo.com, and other white-labels that  */
/*   use i.doodcdn.io assets). These pages are protected by Cloudflare  */
/*   Turnstile (on /e/{filecode}) and Google reCAPTCHA (on /download/), */
/*   so we CANNOT extract the MP4 URL server-side. The extractor        */
/*   returns iframe-type sources pointing to the watch and download      */
/*   pages so the user can open them in a new tab and solve the captcha  */
/*   interactively.                                                     */
/* ------------------------------------------------------------------ */
function extractDoodstreamClone(html: string, finalUrl: string): VideoSource[] | null {
  // Detect doodstream-clone pattern: i.doodcdn.io asset reference + /d/ or /e/ URL.
  const isDoodCloneHtml =
    html.includes("doodcdn.io") ||
    /\/dood\?op=/.test(html) ||
    /DoodStream\.com/i.test(html);
  if (!isDoodCloneHtml) return null;

  // Parse filecode from URL (/d/{filecode} or /e/{filecode} or /f/{filecode}).
  const fcMatch = finalUrl.match(/\/[def]\/([^/?#]+)/);
  if (!fcMatch) return null;
  const filecode = fcMatch[1];

  let origin: string;
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    return null;
  }

  // Extract any one-time /download/{token1}/n/{token2} link from the page
  // (only present on /d/ pages). We surface it as a fallback "direct token"
  // source — but since it requires a captcha-validated POST, we still point
  // users at the /d/ page rather than relying on this token.
  const sources: VideoSource[] = [];

  // Primary: open the watch embed page (user solves Turnstile, then watches).
  sources.push({
    url: `${origin}/e/${filecode}`,
    type: "iframe",
    ext: "html",
    label: "Open watch page · captcha required",
    quality: "Watch",
    pageUrl: finalUrl,
  });

  // Secondary: open the download page (user solves reCAPTCHA, then downloads).
  sources.push({
    url: `${origin}/d/${filecode}`,
    type: "iframe",
    ext: "html",
    label: "Open download page · captcha required",
    quality: "Download",
    pageUrl: finalUrl,
  });

  return sources.length ? sources : null;
}

/** Detect StreamTape and its many mirror/clone domains. StreamTape clones
 *  share the identical page structure (decoy #ideoooolink/#captchalink/
 *  #norobotlink divs + a JS literal with the real &expires=&ip=&token=
 *  triple that gets .substring()'d at runtime), so the same extractor works
 *  for all of them. Known clones: streamtape.com, streamtape.to, streamtape.net,
 *  tpead.net, stape.cc, streamta.pe, stpe.net, tapeplayers.net, shavetape.cash,
 *  tapetv.fr, tapeonline.net, etc. */
function isStreamtapeFamily(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h.includes("streamtape") ||
    h === "tpead.net" ||
    h.endsWith(".tpead.net") ||
    h.includes("stape.") ||
    h === "stpe.net" ||
    h.endsWith(".stpe.net") ||
    h.includes("streamta.pe") ||
    h.includes("tapeplayers") ||
    h.includes("shavetape") ||
    h.includes("tapetv") ||
    h.includes("tapeonline") ||
    // Common StreamTape CDN clone domain suffixes that show the same page
    h.includes("stapewithamazon") ||
    h.includes("stape.club") ||
    h.includes("stape.video") ||
    h.includes("tapeprotect") ||
    h.includes("streamtape") ||
    h.includes("strtape") ||
    h.includes("tapeads")
  );
}

/** Content-based fallback: even when the host is unknown, if the page HTML
 *  contains StreamTape's signature markers (the #ideoooolink div AND a
 *  get_video?id=...&token=... pattern inside a JS string literal), treat it
 *  as a StreamTape clone. This auto-detects new mirror domains. */
function looksLikeStreamtapePage(html: string): boolean {
  return (
    html.includes("ideoooolink") &&
    /['"][^'"]*get_video\?id=[^'"]*&expires=[^'"]*&ip=[^'"]*&token=[^'"]*['"]/i.test(html)
  );
}

/* ------------------------------------------------------------------ */
/* Site: EroMe (erome.com) — porn video & photo sharing.               */
/*   Albums at /a/{album_id} contain one or more <video> blocks, each   */
/*   with one or more <source src="https://v\d+.erome.com/{album_id}/  */
/*   {file}_{q}.mp4" label='HD|SD' res='720|480'> tags. CDN is CORS-   */
/*   open with range support. No captcha. Also handles mirror domains:  */
/*   erome.com, www.erome.com, dev.erome.com, es.erome.com, etc.        */
/* ------------------------------------------------------------------ */
function extractErome(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();
  // Match every <source> tag with a v\d+.erome.com mp4 URL.
  const sourceRe = /<source[^>]+src=["']([^"']+\.erome\.com\/[^"']+\.mp4)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = sourceRe.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const tag = m[0];
    const labelM = tag.match(/\blabel=["']([^"']+)["']/i);
    const resM = tag.match(/\bres=["']([^"']+)["']/i);
    const fileM = url.match(/_([0-9]+p)\.mp4$/i);
    const quality = resM?.[1] ? `${resM[1]}p` : fileM?.[1] || labelM?.[1] || "MP4";
    const label = labelM?.[1] || quality.toUpperCase();
    sources.push({
      url,
      type: "mp4",
      ext: "mp4",
      label: `MP4 · ${label} · ${quality}`,
      quality,
      pageUrl: finalUrl,
    });
  }
  // Poster URLs as image sources (snapshot).
  const posterRe = /<video[^>]+poster=["']([^"']+)["']/gi;
  while ((m = posterRe.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    sources.push({
      url: m[1],
      type: "image",
      ext: "jpg",
      label: "Poster",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: xHamster (xhamster.com, xhamster2.com, xhamster.desi, etc.)   */
/*   Vue SPA page contains a JSON blob with a "sources" object. The     */
/*   HLS m3u8 URL is in plaintext in the HTML:                          */
/*     https://video-nss-b.xhcdn.com/mn-{token},{expiry}/media=hls4/    */
/*     multi=256x144:144p:,...:/025/143/869/_TPL_.av1.mp4.m3u8          */
/*   The CDN allows direct fetch + range support (CORS-open). The m3u8  */
/*   is a master playlist with av1/h264 variants. Also handles         */
/*   xhamster.xxx, xhamster3.com, xhamster18.com, xhamster5.com, etc.  */
/* ------------------------------------------------------------------ */
function extractXhamster(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();
  // 1. Find all m3u8 URLs on xhcdn.com CDN.
  const m3u8Re = /https?:\/\/[^"'\s<>()\\]+?\.xhcdn\.com\/[^"'\s<>()\\]*?\.m3u8[^"'\s<>()\\]*/gi;
  let m: RegExpExecArray | null;
  while ((m = m3u8Re.exec(html)) !== null) {
    const u = m[0].replace(/\\\//g, "/");
    if (seen.has(u)) continue;
    seen.add(u);
    sources.push({
      url: u,
      type: "m3u8",
      ext: "m3u8",
      label: "HLS · xhamster",
      quality: "HLS",
      pageUrl: finalUrl,
    });
  }
  // 2. Look for direct mp4 URLs (videoN.xhcdn.com, NOT thumb-v*.xhcdn.com)
  const mp4Re = /https?:\/\/(?:video\d+\.xhcdn\.com|[^"'\s<>()\\]*?\.xhcdn\.com)\/[^"'\s<>()\\]+?\.mp4[^"'\s<>()\\]*/gi;
  while ((m = mp4Re.exec(html)) !== null) {
    if (/thumb-v\d+\.xhcdn\.com/.test(m[0])) continue;
    const u = m[0].replace(/\\\//g, "/");
    if (seen.has(u)) continue;
    seen.add(u);
    const qM = u.match(/(\d+p)\.(?:h264|av1)/);
    const quality = qM?.[1] || "MP4";
    sources.push({
      url: u,
      type: "mp4",
      ext: "mp4",
      label: `MP4 · ${quality}`,
      quality,
      pageUrl: finalUrl,
    });
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: XVideos + XNXX (xvideos.com, xvideos2.com, xnxx.com, etc.)    */
/*   Both share the same page structure: inline JS calls like           */
/*     html5player.setVideoUrlLow('https://mp4-gcore.xvideos-cdn.com/  */
/*       {hash}/{n}/mp4_sd.mp4?secure=...');                           */
/*     html5player.setVideoUrlHigh('https://...mp4_hd.mp4?secure=...');*/
/*     html5player.setVideoHLS('https://hls-gcore.xvideos-cdn.com/...');*/
/*   The HLS URL is a master playlist with quality variants. CDNs are  */
/*   CORS-open with range support. XNXX uses the same player.          */
/* ------------------------------------------------------------------ */
function extractXvideosFamily(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();
  const reSet = /html5player\.setVideo(Url(?:Low|High|HLS)?|HLS)\s*\(\s*'([^']+)'\s*\)/gi;
  let m: RegExpExecArray | null;
  let highMp4: string | null = null;
  let lowMp4: string | null = null;
  while ((m = reSet.exec(html)) !== null) {
    const fnName = m[1];
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    if (fnName === "HLS" || fnName === "UrlHLS") {
      sources.push({
        url,
        type: "m3u8",
        ext: "m3u8",
        label: "HLS",
        quality: "HLS",
        pageUrl: finalUrl,
      });
    } else if (fnName === "UrlHigh") {
      highMp4 = url;
    } else if (fnName === "UrlLow") {
      lowMp4 = url;
    } else {
      sources.push({
        url,
        type: "mp4",
        ext: "mp4",
        label: "MP4",
        quality: "MP4",
        pageUrl: finalUrl,
      });
    }
  }
  if (highMp4) {
    sources.push({
      url: highMp4,
      type: "mp4",
      ext: "mp4",
      label: "MP4 · HD",
      quality: "720p",
      pageUrl: finalUrl,
    });
  }
  if (lowMp4 && lowMp4 !== highMp4) {
    sources.push({
      url: lowMp4,
      type: "mp4",
      ext: "mp4",
      label: "MP4 · SD",
      quality: "480p",
      pageUrl: finalUrl,
    });
  }
  // Fallback: scan for xvideos-cdn / xnxx-cdn URLs
  if (!sources.length) {
    const re = /https?:\/\/[^"'\s<>()\\]+?(?:xvideos-cdn\.com|xnxx-cdn\.com)\/[^"'\s<>()\\]+?\.(?:mp4|m3u8)[^"'\s<>()\\]*/gi;
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      const isM3u8 = /\.m3u8/i.test(m[0]);
      sources.push({
        url: m[0],
        type: isM3u8 ? "m3u8" : "mp4",
        ext: isM3u8 ? "m3u8" : "mp4",
        label: isM3u8 ? "HLS" : "MP4",
        quality: isM3u8 ? "HLS" : "MP4",
        pageUrl: finalUrl,
      });
    }
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: Pornhub + Redtube + YouPorn (Pornhub network).                */
/*   All three share the same player structure: a flashvars_{id} JSON   */
/*   blob containing a "mediaDefinitions" array. Each entry has:        */
/*     { quality: "1080", format: "hls",                                */
/*       videoUrl: "https://hv-h.phncdn.com/hls/.../master.m3u8?..." }  */
/*   Some entries are format:"mp4" with direct MP4 URLs. CDNs are      */
/*   CORS-open with range support.                                     */
/* ------------------------------------------------------------------ */
function extractPornhubNetwork(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();
  // Find the mediaDefinitions JSON array in the page.
  const mdRe = /"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])\s*[,}]/i;
  const mdM = html.match(mdRe);
  if (mdM) {
    try {
      const arr = JSON.parse(mdM[1]) as Array<{
        format?: string;
        videoUrl?: string;
        quality?: string;
        height?: number;
      }>;
      for (const entry of arr) {
        if (!entry.videoUrl || !/^https?:/.test(entry.videoUrl)) continue;
        if (seen.has(entry.videoUrl)) continue;
        seen.add(entry.videoUrl);
        const isHls = entry.format === "hls" || /\.m3u8/i.test(entry.videoUrl);
        const q = entry.quality || (entry.height ? `${entry.height}p` : undefined);
        sources.push({
          url: entry.videoUrl,
          type: isHls ? "m3u8" : "mp4",
          ext: isHls ? "m3u8" : "mp4",
          label: `${isHls ? "HLS" : "MP4"}${q ? ` · ${q}p` : ""}`,
          quality: q ? `${q}p` : isHls ? "HLS" : "MP4",
          pageUrl: finalUrl,
        });
      }
    } catch {
      // JSON parse failed — fall through
    }
  }
  // Fallback: scan for phncdn.com m3u8 / mp4 URLs
  if (!sources.length) {
    const re = /https?:\/\/[^"'\s<>()\\]+?\.phncdn\.com\/[^"'\s<>()\\]+?\.(?:m3u8|mp4)[^"'\s<>()\\]*/gi;
    while ((m = re.exec(html)) !== null) {
      const u = m[0].replace(/\\\//g, "/");
      if (seen.has(u)) continue;
      seen.add(u);
      const isM3u8 = /\.m3u8/i.test(u);
      sources.push({
        url: u,
        type: isM3u8 ? "m3u8" : "mp4",
        ext: isM3u8 ? "m3u8" : "mp4",
        label: isM3u8 ? "HLS" : "MP4",
        quality: isM3u8 ? "HLS" : "MP4",
        pageUrl: finalUrl,
      });
    }
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: Eporner (eporner.com) — free porn tube.                       */
/*   The page embeds a JSON-LD <script> with contentUrl, BUT that URL   */
/*   (gvideo.eporner.com/{vid}/{vid}.mp4) returns 403 — it's just a     */
/*   placeholder for schema.org. The REAL video URLs are fetched via    */
/*   an XHR API: GET /xhr/video/{vid}?hash={transformed_hash}&domain=   */
/*   www.eporner.com&embed=true&supportedFormats=mp4&_={timestamp}      */
/*   The response JSON has sources.mp4.{quality}.{src,labelShort} with   */
/*   real CDN URLs like vid-s6-n50-fr-cdn.eporner.com/v6/{token}/       */
/*   {expiry}_{ip}_{num}/{fileId}-{quality}.mp4 (CORS-open, range).     */
/*   The hash is transformed: split into 4×8-hex-char chunks, each      */
/*   parseInt(chunk,16).toString(36), concatenated. This is done by     */
/*   the vjs851.js player script.                                       */
/* ------------------------------------------------------------------ */

/** Transform a 32-char hex hash into the base-36 representation the API
 *  expects. Splits into 4×8-hex-char chunks, converts each to base-36. */
function transformEpornerHash(hash: string): string {
  if (!hash || hash.length !== 32) return hash;
  try {
    const p1 = parseInt(hash.substring(0, 8), 16).toString(36);
    const p2 = parseInt(hash.substring(8, 16), 16).toString(36);
    const p3 = parseInt(hash.substring(16, 24), 16).toString(36);
    const p4 = parseInt(hash.substring(24, 32), 16).toString(36);
    return p1 + p2 + p3 + p4;
  } catch {
    return hash;
  }
}

async function extractEporner(html: string, finalUrl: string): Promise<VideoSource[] | null> {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // 1. Extract vid + hash from the EP.video.player config in the page JS.
  //    Format: EP.video.player.vid = 'fIog4Qk47j4';
  //            EP.video.player.hash = '97da5f0bf63aa3bd6eddefa60af01a95';
  const vidM = html.match(/EP\.video\.player\.vid\s*=\s*['"]([^'"]+)['"]/);
  const hashM = html.match(/EP\.video\.player\.hash\s*=\s*['"]([a-f0-9]{32})['"]/i);
  const vid = vidM?.[1];
  const hash = hashM?.[1];

  if (vid && hash) {
    const transformedHash = transformEpornerHash(hash);
    const params = new URLSearchParams({
      hash: transformedHash,
      domain: "www.eporner.com",
      pixelRatio: "1",
      playerWidth: "852",
      playerHeight: "480",
      fallback: "false",
      embed: "true",
      supportedFormats: "mp4",
      _: Date.now().toString(),
    });
    const apiUrl = `https://www.eporner.com/xhr/video/${vid}?${params}`;
    try {
      const r = await curlFetch(apiUrl, {
        timeoutMs: 15000,
        headers: {
          accept: "application/json",
          referer: finalUrl,
          "x-requested-with": "XMLHttpRequest",
        },
      });
      if (r.ok) {
        try {
          const data = JSON.parse(r.text) as {
            available?: boolean;
            sources?: {
              mp4?: Record<string, {
                src?: string;
                labelShort?: string;
                default?: boolean;
              }>;
            };
          };
          if (data.available !== false && data.sources?.mp4) {
            // Sort qualities descending (480p, 360p, 240p).
            const qualities = Object.keys(data.sources.mp4)
              .filter((k) => k !== "auto" && data.sources!.mp4![k]?.src)
              .sort((a, b) => {
                const na = parseInt(a, 10) || 0;
                const nb = parseInt(b, 10) || 0;
                return nb - na;
              });
            for (const q of qualities) {
              const entry = data.sources.mp4[q];
              if (!entry?.src || !/^https?:/.test(entry.src)) continue;
              if (seen.has(entry.src)) continue;
              seen.add(entry.src);
              const label = entry.labelShort || q;
              sources.push({
                url: entry.src,
                type: "mp4",
                ext: "mp4",
                label: `MP4 · ${label}`,
                quality: label,
                pageUrl: finalUrl,
              });
            }
          }
        } catch {
          // JSON parse failed — fall through
        }
      }
    } catch {
      // API fetch failed — fall through
    }
  }

  // 2. Parse JSON-LD <script> block for thumbnail + fallback contentUrl.
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;
  const ldM = html.match(ldRe);
  if (ldM) {
    try {
      const obj = JSON.parse(ldM[1].trim()) as {
        contentUrl?: string;
        embedUrl?: string;
        thumbnailUrl?: string | string[];
        name?: string;
        width?: string | number;
        height?: string | number;
      };
      // Only use contentUrl as a LAST resort (it 403s, but shows the URL
      // to the user in case the API approach fails).
      if (!sources.length && obj.contentUrl && /^https?:/.test(obj.contentUrl) && !seen.has(obj.contentUrl)) {
        seen.add(obj.contentUrl);
        const q = obj.height ? `${obj.height}p` : undefined;
        sources.push({
          url: obj.contentUrl,
          type: "mp4",
          ext: "mp4",
          label: `MP4${q ? ` · ${q}` : ""} · may require referer`,
          quality: q,
          pageUrl: finalUrl,
        });
      }
      // Always add thumbnail as image source.
      const thumb = Array.isArray(obj.thumbnailUrl) ? obj.thumbnailUrl[0] : obj.thumbnailUrl;
      if (thumb && /^https?:/.test(thumb) && !seen.has(thumb)) {
        seen.add(thumb);
        sources.push({
          url: thumb,
          type: "image",
          ext: "jpg",
          label: "Poster",
          quality: "thumbnail",
          pageUrl: finalUrl,
        });
      }
    } catch {
      // fall through
    }
  }

  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: YouTube (youtube.com, youtu.be, m.youtube.com) — the world's   */
/*   largest video platform. The watch page embeds ytInitialPlayerResponse*/
/*   JSON with streamingData.formats (muxed) and streamingData.          */
/*   adaptiveFormats (video+audio only). Modern YouTube serves all      */
/*   formats with a "signatureCipher" param that requires running the    */
/*   page's obfuscated JS interpreter to decode the sig. We can't run    */
/*   JS server-side, so the URL alone (without sig) returns 403.         */
/*   Strategy:                                                          */
/*   1. Surface the embed URL (https://www.youtube.com/embed/{videoId})  */
/*      as an iframe source — user's browser plays it via YouTube's own  */
/*      player (which decodes the sig client-side).                      */
/*   2. Surface the max-res thumbnail as an image source.                */
/*   3. Surface the raw muxed googlevideo URL (itag 18, 360p) WITHOUT    */
/*      the sig — this will 403 in the proxy but is shown for the user   */
/*      to copy if they want to try it.                                  */
/* ------------------------------------------------------------------ */
function extractYouTube(html: string, finalUrl: string): VideoSource[] | null {
  // Extract video ID from URL or page.
  let videoId: string | null = null;
  try {
    const u = new URL(finalUrl);
    if (u.hostname.includes("youtu.be")) {
      videoId = u.pathname.split("/").filter(Boolean)[0] || null;
    } else if (u.searchParams.has("v")) {
      videoId = u.searchParams.get("v");
    } else if (u.pathname.startsWith("/embed/")) {
      videoId = u.pathname.split("/")[2] || null;
    } else if (u.pathname.startsWith("/shorts/")) {
      videoId = u.pathname.split("/")[2] || null;
    } else if (u.pathname.startsWith("/watch/")) {
      videoId = u.pathname.split("/")[2] || null;
    }
  } catch {
    // ignore
  }
  // Fallback: extract from canonical link or og:url in HTML.
  if (!videoId) {
    const canonM = html.match(/<link\s+rel="canonical"\s+href="https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/i);
    if (canonM) videoId = canonM[1];
  }
  if (!videoId) {
    const ogUrlM = html.match(/<meta\s+property="og:url"\s+content="https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/i);
    if (ogUrlM) videoId = ogUrlM[1];
  }
  if (!videoId) {
    const anyM = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (anyM) videoId = anyM[1];
  }
  if (!videoId) return null;

  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // 1. Embed URL — PRIMARY source. This is the official YouTube iframe
  //    player that works in any browser. The watch dialog renders it via
  //    `<iframe src="https://www.youtube.com/embed/{videoId}?autoplay=1">`.
  //    YouTube's player decodes the signatureCipher client-side and plays
  //    the video. Marked as `embeddable: true` so the source-card shows a
  //    "Watch" button instead of "Open page".
  const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
  if (!seen.has(embedUrl)) {
    seen.add(embedUrl);
    sources.push({
      url: embedUrl,
      type: "iframe",
      ext: "html",
      label: "YouTube · play in app",
      quality: "Watch",
      embeddable: true,
      pageUrl: finalUrl,
    });
  }

  // 2. Thumbnail as image source (always works).
  const thumbMax = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  if (!seen.has(thumbMax)) {
    seen.add(thumbMax);
    sources.push({
      url: thumbMax,
      type: "image",
      ext: "jpg",
      label: "Thumbnail · maxres",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }
  const thumbHq = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  if (!seen.has(thumbHq)) {
    seen.add(thumbHq);
    sources.push({
      url: thumbHq,
      type: "image",
      ext: "jpg",
      label: "Thumbnail · hq",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }

  // 3. Original page as iframe fallback (open in new tab).
  if (!seen.has(finalUrl)) {
    seen.add(finalUrl);
    sources.push({
      url: finalUrl,
      type: "iframe",
      ext: "html",
      label: "Open YouTube page",
      quality: "Open",
      pageUrl: finalUrl,
    });
  }

  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: Facebook (facebook.com) — videos, reels, watch.               */
/*   Facebook requires login to view most video content. The public    */
/*   watch page returns a login-walled HTML shell. The CDN URL         */
/*   (video.xx.fbcdn.net) is only exposed inside the authenticated     */
/*   React/Relay store JSON and requires a logged-in session cookie.    */
/*   We can't extract server-side. Surface the page as an iframe +     */
/*   any og:image thumbnail (always public).                           */
/* ------------------------------------------------------------------ */
function extractFacebook(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // 1. og:image — Facebook always exposes the video poster publicly.
  const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (ogImg && !seen.has(ogImg[1])) {
    seen.add(ogImg[1]);
    sources.push({
      url: ogImg[1],
      type: "image",
      ext: "jpg",
      label: "Thumbnail · Facebook",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }
  // 2. og:video (rare for FB but sometimes present for public videos).
  const ogVid = html.match(/<meta\s+property="og:video(?::?\w*)"\s+content="([^"]+)"/i);
  if (ogVid && /^https?:/.test(ogVid[1]) && !seen.has(ogVid[1])) {
    seen.add(ogVid[1]);
    sources.push({
      url: ogVid[1],
      type: "mp4",
      ext: "mp4",
      label: "MP4 · Facebook · public",
      quality: "MP4",
      pageUrl: finalUrl,
    });
  }
  // 3. Embeddable iframe — Facebook's official /plugins/video.php?href=
  //    endpoint renders the video in an iframe player. Works for public
  //    videos without login. Marked as `embeddable: true` so the watch
  //    dialog renders it via `<iframe>`.
  const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(finalUrl)}&show_text=false&width=560&autoplay=true`;
  if (!seen.has(embedUrl)) {
    seen.add(embedUrl);
    sources.push({
      url: embedUrl,
      type: "iframe",
      ext: "html",
      label: "Facebook · play in app",
      quality: "Watch",
      embeddable: true,
      pageUrl: finalUrl,
    });
  }
  // 4. Iframe source — open the original page in a new tab.
  if (!seen.has(finalUrl)) {
    seen.add(finalUrl);
    sources.push({
      url: finalUrl,
      type: "iframe",
      ext: "html",
      label: "Open Facebook page · login may be required",
      quality: "Open",
      pageUrl: finalUrl,
    });
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: Instagram (instagram.com) — reels, posts, TV.                 */
/*   Instagram requires login for most content. Public reels sometimes  */
/*   expose og:video but it's gated by signed CDN URLs that expire     */
/*   quickly. We surface og:image (always public) + iframe source.     */
/* ------------------------------------------------------------------ */
function extractInstagram(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();
  // 1. og:image (always public for public posts).
  const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (ogImg && !seen.has(ogImg[1])) {
    seen.add(ogImg[1]);
    sources.push({
      url: ogImg[1],
      type: "image",
      ext: "jpg",
      label: "Thumbnail · Instagram",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }
  // 2. og:video (rare but present for some public reels).
  const ogVid = html.match(/<meta\s+property="og:video(?::?\w*)"\s+content="([^"]+)"/i);
  if (ogVid && /^https?:/.test(ogVid[1]) && !seen.has(ogVid[1])) {
    seen.add(ogVid[1]);
    sources.push({
      url: ogVid[1],
      type: "mp4",
      ext: "mp4",
      label: "MP4 · Instagram · public",
      quality: "MP4",
      pageUrl: finalUrl,
    });
  }
  // 3. Embeddable iframe — Instagram's official /reel/{id}/embed/ or
  //    /p/{id}/embed/ endpoint renders the post in an iframe player.
  //    Works for public posts without login.
  let embedUrl: string | null = null;
  try {
    const u = new URL(finalUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    // Patterns: /reel/{id}/, /reels/{id}/, /p/{id}/, /tv/{id}/
    if (parts.length >= 2 && ["reel", "reels", "p", "tv"].includes(parts[0])) {
      embedUrl = `${u.origin}/${parts[0]}/${parts[1]}/embed/captioned/`;
    }
  } catch {
    // ignore
  }
  if (embedUrl && !seen.has(embedUrl)) {
    seen.add(embedUrl);
    sources.push({
      url: embedUrl,
      type: "iframe",
      ext: "html",
      label: "Instagram · play in app",
      quality: "Watch",
      embeddable: true,
      pageUrl: finalUrl,
    });
  }
  // 4. Iframe source — open the original page in a new tab.
  if (!seen.has(finalUrl)) {
    seen.add(finalUrl);
    sources.push({
      url: finalUrl,
      type: "iframe",
      ext: "html",
      label: "Open Instagram page · login may be required",
      quality: "Open",
      pageUrl: finalUrl,
    });
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: Telegram (t.me, telegram.me) — channel/group posts.           */
/*   Telegram's /embed/ endpoint (t.me/{channel}/{id}?embed=1) returns  */
/*   a public preview HTML with og:video / og:video:secure_url meta     */
/*   tags pointing to cdnN.telegram.org / telesco.pe MP4 URLs (CORS-    */
/*   open, range support). For text-only posts, only og:image is       */
/*   present. We fetch the embed URL separately if the original URL     */
/*   doesn't expose og:video.                                          */
/* ------------------------------------------------------------------ */
async function extractTelegram(html: string, finalUrl: string): Promise<VideoSource[] | null> {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // 1. Try og:video / og:video:secure_url / og:video:url from the
  //    original HTML.
  const ogVidRe = /<meta\s+property="og:video(?::?\w*)"\s+content="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = ogVidRe.exec(html)) !== null) {
    if (/^https?:/.test(m[1]) && !seen.has(m[1])) {
      seen.add(m[1]);
      sources.push({
        url: m[1],
        type: "mp4",
        ext: "mp4",
        label: "MP4 · Telegram · public",
        quality: "MP4",
        pageUrl: finalUrl,
      });
    }
  }
  // 2. og:image (always public).
  const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (ogImg && !seen.has(ogImg[1])) {
    seen.add(ogImg[1]);
    sources.push({
      url: ogImg[1],
      type: "image",
      ext: "jpg",
      label: "Thumbnail · Telegram",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }

  // 3. If no og:video found yet, try the embed URL: t.me/{channel}/{id}?embed=1
  //    This endpoint returns a different page that exposes og:video for
  //    video messages. Only fetch if the original URL looks like a post URL.
  if (!sources.some((s) => s.type === "mp4")) {
    let embedUrl: string | null = null;
    try {
      const u = new URL(finalUrl);
      const parts = u.pathname.split("/").filter(Boolean);
      // Pattern: t.me/{channel}/{postId}
      if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        embedUrl = `${u.origin}/${parts[0]}/${parts[1]}?embed=1`;
      }
    } catch {
      // ignore
    }
    if (embedUrl) {
      try {
        const r = await curlFetch(embedUrl, { timeoutMs: 15000 });
        if (r.ok) {
          const ogVidRe2 = /<meta\s+property="og:video(?::?\w*)"\s+content="([^"]+)"/gi;
          while ((m = ogVidRe2.exec(r.text)) !== null) {
            if (/^https?:/.test(m[1]) && !seen.has(m[1])) {
              seen.add(m[1]);
              sources.push({
                url: m[1],
                type: "mp4",
                ext: "mp4",
                label: "MP4 · Telegram · embed",
                quality: "MP4",
                pageUrl: finalUrl,
              });
            }
          }
          // Also look for twitter:player:stream
          const twRe = /<meta\s+name="twitter:player:stream[^"]*"\s+content="([^"]+)"/gi;
          while ((m = twRe.exec(r.text)) !== null) {
            if (/^https?:/.test(m[1]) && !seen.has(m[1])) {
              seen.add(m[1]);
              sources.push({
                url: m[1],
                type: "mp4",
                ext: "mp4",
                label: "MP4 · Telegram · stream",
                quality: "MP4",
                pageUrl: finalUrl,
              });
            }
          }
        }
      } catch {
        // embed fetch failed — fall through
      }
    }
  }

  // 4. Embeddable iframe — Telegram's ?embed=1&mode=tme endpoint renders
  //    the post (text + image + video) in an iframe widget that works
  //    without login. Marked as `embeddable: true` so the watch dialog
  //    renders it via `<iframe>`.
  let tgEmbedUrl: string | null = null;
  try {
    const u = new URL(finalUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      tgEmbedUrl = `${u.origin}/${parts[0]}/${parts[1]}?embed=1&mode=tme`;
    }
  } catch {
    // ignore
  }
  if (tgEmbedUrl && !seen.has(tgEmbedUrl)) {
    seen.add(tgEmbedUrl);
    sources.push({
      url: tgEmbedUrl,
      type: "iframe",
      ext: "html",
      label: "Telegram · play in app",
      quality: "Watch",
      embeddable: true,
      pageUrl: finalUrl,
    });
  }

  // 5. Iframe source — open the original page in a new tab.
  if (!seen.has(finalUrl)) {
    seen.add(finalUrl);
    sources.push({
      url: finalUrl,
      type: "iframe",
      ext: "html",
      label: "Open Telegram post",
      quality: "Open",
      pageUrl: finalUrl,
    });
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: VK (vk.com) — Russian social network.                          */
/*   VK video pages are fully Vue SPA with bot detection. The video    */
/*   CDN URL (userapi.com / vk.com) requires signed hash params that    */
/*   are only computed after the SPA boots. We surface og:image (often   */
/*   present) + iframe source.                                          */
/* ------------------------------------------------------------------ */
function extractVK(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();
  // 1. og:image.
  const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (ogImg && !seen.has(ogImg[1])) {
    seen.add(ogImg[1]);
    sources.push({
      url: ogImg[1],
      type: "image",
      ext: "jpg",
      label: "Thumbnail · VK",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }
  // 2. og:video (rare but sometimes present).
  const ogVid = html.match(/<meta\s+property="og:video(?::?\w*)"\s+content="([^"]+)"/i);
  if (ogVid && /^https?:/.test(ogVid[1]) && !seen.has(ogVid[1])) {
    seen.add(ogVid[1]);
    sources.push({
      url: ogVid[1],
      type: "mp4",
      ext: "mp4",
      label: "MP4 · VK · public",
      quality: "MP4",
      pageUrl: finalUrl,
    });
  }
  // 3. Embeddable iframe — VK's /video_ext.php?oid={oid}&id={id}&hash={hash}
  //    endpoint renders the video in an iframe player. The hash is required
  //    for private videos; for public videos, an empty hash often works.
  //    URL pattern: vk.com/video{oid}_{id} or vk.com/video/{oid}/{id}
  let embedUrl: string | null = null;
  try {
    const u = new URL(finalUrl);
    const path = u.pathname;
    // Pattern 1: /video{oid}_{id}
    const m1 = path.match(/\/video(-?\d+)_(\d+)/);
    if (m1) {
      embedUrl = `https://vk.com/video_ext.php?oid=${m1[1]}&id=${m1[2]}&hash=&hd=2&autoplay=1`;
    }
    if (!embedUrl) {
      // Pattern 2: /video/{oid}/{id}
      const m2 = path.match(/\/video\/(-?\d+)\/(\d+)/);
      if (m2) {
        embedUrl = `https://vk.com/video_ext.php?oid=${m2[1]}&id=${m2[2]}&hash=&hd=2&autoplay=1`;
      }
    }
  } catch {
    // ignore
  }
  if (embedUrl && !seen.has(embedUrl)) {
    seen.add(embedUrl);
    sources.push({
      url: embedUrl,
      type: "iframe",
      ext: "html",
      label: "VK · play in app",
      quality: "Watch",
      embeddable: true,
      pageUrl: finalUrl,
    });
  }
  // 4. Iframe source — open the original page in a new tab.
  if (!seen.has(finalUrl)) {
    seen.add(finalUrl);
    sources.push({
      url: finalUrl,
      type: "iframe",
      ext: "html",
      label: "Open VK page · bot-protected SPA",
      quality: "Open",
      pageUrl: finalUrl,
    });
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: X.com / Twitter (x.com, twitter.com) — video tweets.           */
/*   X.com serves a logged-out HTML shell with minimal meta tags. The  */
/*   actual video CDN URL (video.twimg.com) is only exposed via the     */
/*   GraphQL API which requires authentication. We surface og:image     */
/*   (always public — the tweet's media preview) + iframe source.       */
/* ------------------------------------------------------------------ */
function extractXCom(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();
  // 1. og:image — for video tweets this is the video poster frame.
  const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (ogImg && !seen.has(ogImg[1])) {
    seen.add(ogImg[1]);
    sources.push({
      url: ogImg[1],
      type: "image",
      ext: "jpg",
      label: "Thumbnail · X.com",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }
  // 2. og:video (rare but sometimes present).
  const ogVid = html.match(/<meta\s+property="og:video(?::?\w*)"\s+content="([^"]+)"/i);
  if (ogVid && /^https?:/.test(ogVid[1]) && !seen.has(ogVid[1])) {
    seen.add(ogVid[1]);
    sources.push({
      url: ogVid[1],
      type: "mp4",
      ext: "mp4",
      label: "MP4 · X.com · public",
      quality: "MP4",
      pageUrl: finalUrl,
    });
  }
  // 3. Embeddable iframe — Twitter/X's official embed endpoint:
  //    https://platform.twitter.com/embed/Tweet.html?id={tweetId}
  //    Renders the tweet (with embedded video) in an iframe player.
  let embedUrl: string | null = null;
  try {
    const u = new URL(finalUrl);
    // Pattern: x.com/{user}/status/{id} or twitter.com/{user}/status/{id}
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[1] === "status" && /^\d+$/.test(parts[2])) {
      embedUrl = `https://platform.twitter.com/embed/Tweet.html?id=${parts[2]}`;
    }
  } catch {
    // ignore
  }
  if (embedUrl && !seen.has(embedUrl)) {
    seen.add(embedUrl);
    sources.push({
      url: embedUrl,
      type: "iframe",
      ext: "html",
      label: "X.com · play in app",
      quality: "Watch",
      embeddable: true,
      pageUrl: finalUrl,
    });
  }
  // 4. Iframe source — open the original page in a new tab.
  if (!seen.has(finalUrl)) {
    seen.add(finalUrl);
    sources.push({
      url: finalUrl,
      type: "iframe",
      ext: "html",
      label: "Open X.com post · login may be required",
      quality: "Open",
      pageUrl: finalUrl,
    });
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: Threads (threads.net, threads.com) — Meta's text platform.    */
/*   Threads is a Vue SPA that requires JavaScript to render content.   */
/*   The HTML shell doesn't expose video URLs. We surface og:image      */
/*   (always present for media posts) + iframe source.                  */
/* ------------------------------------------------------------------ */
function extractThreads(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();
  // 1. og:image.
  const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (ogImg && !seen.has(ogImg[1])) {
    seen.add(ogImg[1]);
    sources.push({
      url: ogImg[1],
      type: "image",
      ext: "jpg",
      label: "Thumbnail · Threads",
      quality: "thumbnail",
      pageUrl: finalUrl,
    });
  }
  // 2. og:video (rare but present for some video posts).
  const ogVid = html.match(/<meta\s+property="og:video(?::?\w*)"\s+content="([^"]+)"/i);
  if (ogVid && /^https?:/.test(ogVid[1]) && !seen.has(ogVid[1])) {
    seen.add(ogVid[1]);
    sources.push({
      url: ogVid[1],
      type: "mp4",
      ext: "mp4",
      label: "MP4 · Threads · public",
      quality: "MP4",
      pageUrl: finalUrl,
    });
  }
  // 3. Iframe source.
  if (!seen.has(finalUrl)) {
    seen.add(finalUrl);
    sources.push({
      url: finalUrl,
      type: "iframe",
      ext: "html",
      label: "Open Threads post · login may be required",
      quality: "Open",
      pageUrl: finalUrl,
    });
  }
  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: DrTuber (drtuber.com, m.drtuber.desi, drtuber.desi) — tube site. */
/*   The video page has a /play/{videoId} link that returns a redirect  */
/*   page containing the actual MP4 URL on xcdn.drtuber.desi:           */
/*   https://xcdn.drtuber.desi/mp4/{hash}.mp4?cdn_hash=...&cdn_ttl=...  */
/*   The URL is IP-bound but works for ~1 hour. We fetch /play/{id} and */
/*   extract the xcdn MP4 URL.                                         */
/* ------------------------------------------------------------------ */
async function extractDrtuber(html: string, finalUrl: string): Promise<VideoSource[] | null> {
  // Extract video ID from URL or HTML.
  let videoId: string | null = null;
  try {
    const u = new URL(finalUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    // Pattern: /video/{id}/{slug}
    if (parts.length >= 2 && parts[0] === "video") {
      videoId = parts[1];
    }
    // Pattern: /embed/{id}
    if (parts.length >= 2 && parts[0] === "embed") {
      videoId = parts[1];
    }
  } catch {
    // ignore
  }
  // Fallback: search HTML for videoId
  if (!videoId) {
    const m = html.match(/videoId\s*:\s*(\d+)/);
    if (m) videoId = m[1];
  }
  if (!videoId) return null;

  // Determine the origin (handle m.drtuber.desi, drtuber.com, etc.)
  let origin: string;
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    origin = "https://www.drtuber.com";
  }

  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // Fetch /play/{videoId} to get the actual MP4 URL.
  try {
    const playUrl = `${origin}/play/${videoId}?from=video_bottom`;
    const r = await curlFetch(playUrl, {
      timeoutMs: 15000,
      headers: { referer: finalUrl },
    });
    if (r.ok) {
      // Extract xcdn.drtuber.desi MP4 URL (the real video file).
      // URL format: https://xcdn.drtuber.desi/mp4/{hash}.mp4?cdn_hash=...&cdn_ttl=...
      const mp4Re = /https?:\/\/xcdn\.[^"'\s<>()\\]+?\.mp4[^"'\s<>()\\]*/i;
      const m = r.text.match(mp4Re);
      if (m && !seen.has(m[0])) {
        seen.add(m[0]);
        sources.push({
          url: m[0],
          type: "mp4",
          ext: "mp4",
          label: "MP4",
          quality: "MP4",
          pageUrl: finalUrl,
        });
      }
    }
  } catch {
    // fall through
  }

  // Fallback: scan the original page HTML for xcdn MP4 URLs
  if (!sources.length) {
    const mp4Re = /https?:\/\/xcdn\.[^"'\s<>()\\]+?\.mp4[^"'\s<>()\\]*/gi;
    let m: RegExpExecArray | null;
    while ((m = mp4Re.exec(html)) !== null) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      sources.push({
        url: m[0],
        type: "mp4",
        ext: "mp4",
        label: "MP4",
        quality: "MP4",
        pageUrl: finalUrl,
      });
    }
  }

  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: Xozilla (xozilla.xxx) — tube site.                            */
/*   The video page contains /get_file/23/{hash}/{id}000/{id}/{id}.mp4/ */
/*   and /get_file/23/{hash}/{id}000/{id}/{id}hd.mp4/ URLs. These      */
/*   redirect (302) to vcdn.xozilla.xxx → ahcdn.com CDN which serves   */
/*   the actual MP4 with CORS-open, range support. The /get_file/1/    */
/*   URLs are preview GIFs (skip those).                               */
/* ------------------------------------------------------------------ */
function extractXozilla(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // Find all /get_file/ URLs. Only /get_file/23/ (or higher first segment)
  // are real video files; /get_file/1/ are preview GIFs.
  const gfRe = /https?:\/\/[^"'\s<>()\\]+?\/get_file\/(\d+)\/[^"'\s<>()\\]+\/(\d+)\/(\d+)\/(\d+)(hd)?\.mp4\/?/gi;
  let m: RegExpExecArray | null;
  while ((m = gfRe.exec(html)) !== null) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const firstSeg = parseInt(m[1], 10);
    const isHd = m[5] === "hd";
    // Skip /get_file/1/ (previews). Only keep /get_file/2+/ (real videos).
    if (firstSeg < 2) continue;
    const quality = isHd ? "HD" : "SD";
    sources.push({
      url,
      type: "mp4",
      ext: "mp4",
      label: `MP4 · ${quality}`,
      quality: isHd ? "720p" : "480p",
      pageUrl: finalUrl,
    });
  }

  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: PornDr (porndr.com) — tube site.                              */
/*   The video page contains a video_url JS var with a /get_file/ URL  */
/*   that includes a v-acctoken query param. The URL redirects (302)   */
/*   to vcdn1.porndr.com → ahcdn.com CDN. The token is IP-bound but    */
/*   works when the referer is the full video page URL. Skip           */
/*   _preview.mp4 URLs (short previews).                               */
/* ------------------------------------------------------------------ */
async function extractPorndr(html: string, finalUrl: string): Promise<VideoSource[] | null> {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // Determine the origin for the page param. PornDr's CDN rejects requests
  // with the full video page URL as referer, but accepts the origin
  // (https://www.porndr.com/). So we pass only the origin as pageUrl.
  let origin: string;
  try {
    origin = new URL(finalUrl).origin + "/";
  } catch {
    origin = "https://www.porndr.com/";
  }

  // Find all /get_file/ URLs that are NOT _preview.mp4.
  // Format: /get_file/1/{hash}/{id}000/{id}/{id}_{quality}.mp4/?v-acctoken={token}
  // Skip _preview.mp4 URLs (short preview clips, not the full video).
  const gfRe = /https?:\/\/[^"'\s<>()\\]+?\/get_file\/\d+\/[^"'\s<>()\\]+\/(\d+)\/(\d+)\/(\d+)(?:_(\d+p|hd))?\.mp4\/?\?v-acctoken=[^"'\s<>()\\]+/gi;
  const rawUrls: Array<{ url: string; quality: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = gfRe.exec(html)) !== null) {
    const url = m[0];
    // Skip _preview.mp4 URLs
    if (/_preview\.mp4/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const quality = m[4] || "MP4";
    rawUrls.push({ url, quality });
  }

  // Also look for the video_url JS variable directly (more reliable).
  if (!rawUrls.length) {
    const vuRe = /video_url\s*:\s*['"]([^'"]+\/get_file\/[^'"]+)['"]/i;
    const vuM = html.match(vuRe);
    if (vuM && !seen.has(vuM[1])) {
      seen.add(vuM[1]);
      const qM = vuM[1].match(/_(\d+p|hd)\.mp4/i);
      const quality = qM?.[1] || "MP4";
      rawUrls.push({ url: vuM[1], quality });
    }
  }

  // The v-acctoken expires within seconds. Follow the redirect chain
  // server-side to get the final ahcdn.com URL (which has a longer-lived
  // key= param). The ahcdn.com CDN has CORS * and range support.
  for (const { url, quality } of rawUrls) {
    try {
      const r = await curlFetch(url, {
        timeoutMs: 10000,
        headers: { referer: origin },
        maxRedirects: 0, // don't follow redirects — capture Location header
      });
      // The get_file URL returns 302 → vcdn1.porndr.com → 302 → ahcdn.com
      // r.redirectUrl contains the Location header value.
      if (r.redirectUrl && /^https?:/.test(r.redirectUrl)) {
        const vcdnUrl = r.redirectUrl;
        // Follow the vcdn1 redirect to get the final ahcdn.com URL.
        const r2 = await curlFetch(vcdnUrl, {
          timeoutMs: 10000,
          maxRedirects: 0,
        });
        if (r2.redirectUrl && /^https?:/.test(r2.redirectUrl)) {
          const ahcdnUrl = r2.redirectUrl;
          if (!seen.has(ahcdnUrl)) {
            seen.add(ahcdnUrl);
            sources.push({
              url: ahcdnUrl,
              type: "mp4",
              ext: "mp4",
              label: `MP4 · ${quality}`,
              quality,
              pageUrl: origin,
            });
          }
        }
      }
    } catch {
      // If redirect resolution fails, fall back to the raw URL.
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({
          url,
          type: "mp4",
          ext: "mp4",
          label: `MP4 · ${quality}`,
          quality,
          pageUrl: origin,
        });
      }
    }
  }

  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: ukdevilz (ukdevilz.com) — tube site using JW Player.           */
/*   Watch URL pattern: /watch/{id1}_{id2}                              */
/*   The page embeds a JW Player setup JSON with "file" entries pointing */
/*   to cdn.pvvstream.pro / cdn2.pvvstream.pro MP4 files with a signed   */
/*   `secure=` token. The page ALSO contains a fake placeholder URL at    */
/*   /videofile/{id1}_{id2}.mp4 which returns HTTP 404 — we must skip    */
/*   that. Only "file" entries whose path includes /{id1}/{id2}/ are for */
/*   the current video; the page also lists related-video URLs with      */
/*   different id pairs.                                                */
/* ------------------------------------------------------------------ */
function extractUkdevilz(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];
  const seen = new Set<string>();

  // Extract the video id pair from the watch URL: /watch/-192485747_456239918
  let idPair: string | null = null;
  const watchM = finalUrl.match(/\/watch\/(-?\d+)_(\d+)/i);
  if (watchM) {
    idPair = `${watchM[1]}/${watchM[2]}`;
  }

  // JW Player setup JSON contains entries like:
  //   "file":"https://cdn.pvvstream.pro/videos/-192485747/456239918/vid_360p.mp4?rs=360000\u0026rb=1398101\u0026secure=..."
  // \u0026 is JSON-escaped &. We match the full URL up to the closing quote.
  const fileRe = /"file"\s*:\s*"(https?:\\?\/\\?\/[^"]*?pvvstream\.pro[^"]*?\.mp4[^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(html)) !== null) {
    // Unescape JSON \u0026 → & and \u002F → / (just in case).
    let url = m[1].replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
    // Some pages escape the whole URL with backslashes.
    url = url.replace(/\\\//g, "/");
    if (seen.has(url)) continue;
    // Only keep URLs for the CURRENT video (matching id pair). The page
    // also lists related videos with different id pairs — skip those.
    if (idPair && !url.includes(`/${idPair}/`)) continue;
    seen.add(url);
    // Extract quality from the filename: vid_360p.mp4, vid_240p.mp4, tr_720p.mp4
    const qM = url.match(/(?:vid|tr|v)_(\d+)p\.mp4/i);
    const quality = qM ? `${qM[1]}p` : "MP4";
    sources.push({
      url,
      type: "mp4",
      ext: "mp4",
      label: `MP4 · ${quality}`,
      quality,
      pageUrl: finalUrl,
    });
  }

  // Sort by quality descending (higher number first).
  sources.sort((a, b) => {
    const qa = parseInt((a.quality || "0").replace(/\D/g, ""), 10) || 0;
    const qb = parseInt((b.quality || "0").replace(/\D/g, ""), 10) || 0;
    return qb - qa;
  });

  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Site: vids.st (vids.st) — video hosting with HLS streaming.          */
/*   Watch URL pattern: /v/{id}   Embed URL: /e/{id}                    */
/*   The page embeds a playerConfig JSON with:                          */
/*     - videoUrl: https://cdn.vids.st/video{id}/master.m3u8            */
/*     - thumbnail: https://cdn.vids.st/video{id}/thumb{id}.jpg         */
/*   The CDN (cdn.vids.st) is IP/geo-restricted — it returns HTTP 404   */
/*   for our server IP but works fine for the user's browser. So we     */
/*   return TWO sources:                                               */
/*     1. PRIMARY: embeddable iframe → https://vids.st/e/{id}           */
/*        The embed page is a self-contained ArtPlayer + hls.js player  */
/*        that loads directly in the user's browser (no X-Frame-Options).*/
/*        This is the most reliable way to preview the video.           */
/*     2. FALLBACK: the raw HLS m3u8 URL marked as direct (not proxied).*/
/*        hls.js in the browser fetches it directly; if the user's IP   */
/*        is allowed, it plays.                                         */
/* ------------------------------------------------------------------ */
function extractVidsSt(html: string, finalUrl: string): VideoSource[] | null {
  const sources: VideoSource[] = [];

  // Extract video ID from URL: /v/{id} or /e/{id}
  let videoId: string | null = null;
  try {
    const u = new URL(finalUrl);
    const m = u.pathname.match(/^\/(?:v|e)\/(\d+)/i);
    if (m) videoId = m[1];
  } catch {
    // ignore
  }
  // Fallback: extract from playerConfig in HTML
  if (!videoId) {
    const idM = html.match(/"videoId"\s*:\s*(\d+)/);
    if (idM) videoId = idM[1];
  }
  if (!videoId) return null;

  // Extract the m3u8 URL from playerConfig (watch page) or const url (embed page).
  // Watch page: "videoUrl":"https://cdn.vids.st/video5524/master.m3u8"
  // Embed page: const url = "https:\/\/cdn.vids.st\/video5524\/master.m3u8";
  let m3u8Url: string | null = null;
  const vuM = html.match(/"videoUrl"\s*:\s*"(https?:\\?\/\\?\/[^"]+\.m3u8[^"]*)"/);
  if (vuM) {
    m3u8Url = vuM[1].replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
  }
  if (!m3u8Url) {
    const cuM = html.match(/const\s+url\s*=\s*"(https?:\\?\/\\?\/[^"]+\.m3u8[^"]*)"/);
    if (cuM) {
      m3u8Url = cuM[1].replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
    }
  }
  // Construct from videoId if still not found (pattern is predictable)
  if (!m3u8Url) {
    m3u8Url = `https://cdn.vids.st/video${videoId}/master.m3u8`;
  }

  // Extract thumbnail
  let thumb: string | null = null;
  const thM = html.match(/"thumbnail"\s*:\s*"(https?:\\?\/\\?\/[^"]+thumb[^"]*)"/);
  if (thM) {
    thumb = thM[1].replace(/\\\//g, "/");
  }
  if (!thumb) {
    const thM2 = html.match(/const\s+poster\s*=\s*"(https?:\\?\/\\?\/[^"]+thumb[^"]*)"/);
    if (thM2) thumb = thM2[1].replace(/\\\//g, "/");
  }

  // 1. PRIMARY: embeddable iframe → https://vids.st/e/{id}
  //    The embed page is a self-contained player that runs in the user's
  //    browser, so the CDN sees the user's IP (which is allowed).
  const embedUrl = `https://vids.st/e/${videoId}`;
  sources.push({
    url: embedUrl,
    type: "iframe",
    ext: "html",
    label: "vids.st · play in app",
    quality: "Watch",
    embeddable: true,
    pageUrl: finalUrl,
  });

  // 2. FALLBACK: raw HLS m3u8 URL (direct — not proxied through our server
  //    because the CDN blocks our IP). The browser's hls.js fetches it
  //    directly; works when the user's IP is allowed by the CDN.
  if (m3u8Url) {
    sources.push({
      url: m3u8Url,
      type: "m3u8",
      ext: "m3u8",
      label: "HLS · direct",
      quality: "HLS",
      pageUrl: finalUrl,
    });
  }

  return sources.length ? sources : null;
}

/* ------------------------------------------------------------------ */
/* Generic helper for captcha-protected hosts: returns a single iframe   */
/* source pointing to the original URL so the user can open the page in  */
/* their browser and solve the captcha (Cloudflare Turnstile, hCaptcha,  */
/* Cloudflare "Just a moment..." interstitial, WASM-based obfuscation,   */
/* Vite SPA with bot detection) interactively.                           */
/* ------------------------------------------------------------------ */
function extractCloudflareIframe(finalUrl: string, label: string): VideoSource[] {
  return [
    {
      url: finalUrl,
      type: "iframe",
      ext: "html",
      label,
      quality: "Open",
      pageUrl: finalUrl,
    },
  ];
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
    } else if (host.includes("vidara") || host.includes("odysseusa")) {
      // Vidara + Odysseusa share the same codebase (Vue SPA + /api/stream
      // POST endpoint). Their mirror domains include vidara.to, vidara.com,
      // odysseusa.cc, odysseusa.to, etc.
      if (host.includes("odysseusa")) {
        const fc = finalUrl.match(/\/e\/([^/?#]+)/);
        if (fc) sources = await extractOdysseusa(fc[1], new URL(finalUrl).origin, finalUrl);
      } else {
        sources = await extractVidara(html, finalUrl);
      }
    } else if (
      // MixDrop family — covers mixdrop.co, mixdrop.to, mixdrop.sx, mixdrop.bz,
      // mixdrop.ch, mixdrop.gl, mixdrop.nu, mixdrop.vc, mixdrop.ag, miiiixdrop.com,
      // mixdroop.co, mixdroop.bz, mixdroop.ws, mixdroop.nl, and many other
      // mirror domains. All share the same packer + /f/{id} page structure.
      host.includes("mixdrop") || host.includes("miiiixdrop") ||
      host.includes("mixdroop") || host.includes("mixdroup")
    ) {
      sources = await extractMixdrop(html, finalUrl);
    } else if (isStreamtapeFamily(host)) {
      sources = extractStreamtape(html, finalUrl);
    } else if (
      // DoodStream family — covers doodstream.com, dood.so, dood.yt,
      // doodstream.co, dood.li, doodstream.watch, dood.pm, dood.ws, dood.rust,
      // and all other "dood.*" mirror domains.
      host.includes("doodstream") || host.includes("dood.so") ||
      host.includes("dood.yt") || host.includes("dood.") ||
      host.includes("doodpm") || host.includes("doodhq") ||
      host.includes("doodmovies") || host.includes("doodwatch")
    ) {
      sources = await extractDoodstream(html, finalUrl);
    } else if (
      // Morencius / VidHide embed hosts. Many white-label front-ends
      // (minochinos.com, etc.) iframe to these — when the user pastes the
      // embed URL directly, dispatch here. When the user pastes the front-end
      // URL, the content-based fallback below catches it via the packer.
      // Expanded to cover the many VidHide white-label mirror domains.
      host.includes("morencius") || host.includes("vidhide") ||
      host.includes("minochinos") || host.includes("playmogo") ||
      host.includes("mosevura") || host.includes("dramiyos") ||
      host.includes("earnvids") || host.includes("vidhidepro") ||
      host.includes("vidhidelink") || host.includes("vidhidecity") ||
      host.includes("vidshide") || host.includes("vidshost") ||
      host.includes("mexash") || host.includes("fileabc") ||
      host.includes("tachist") || host.includes("indobaliu") ||
      host.includes("boodstream") || host.includes("vidoo")
    ) {
      // DoodStream clone (playmogo.com, etc.) — detect via HTML content.
      if (
        host.includes("playmogo") ||
        html.includes("doodcdn.io") ||
        /\/dood\?op=/.test(html) ||
        /DoodStream\.com/i.test(html)
      ) {
        sources = extractDoodstreamClone(html, finalUrl);
      }
      // Morencius / VidHide pattern: packer → var links = {hls4,hls3,hls2}.
      if (!sources) {
        sources = extractMorenciusFamily(html, finalUrl);
      }
    } else if (
      // StreamWish / Swhoi / FileLions / VidPlay family — covers streamwish.to,
      // swhoi.com, filelions.to, filelions.com, embedwish.com, awish.pro,
      // mhdflix.in, vidplay.stream, vidplay.site, player.akamai.net,
      // streamwish.com (=StreamHG), supervideo.tv, streamhub.to, megacloud.to,
      // kalelmeh.com, moviehab.fun, vidgomax.com, yzzzz.stream, streamcloud.cc
      host.includes("streamwish") || host.includes("swhoi") ||
      host.includes("filelions") || host.includes("filelion") ||
      host.includes("embedwish") || host.includes("awish") ||
      host.includes("mhdflix") || host.includes("vidplay") ||
      host.includes("supervideo") || host.includes("streamhub") ||
      host.includes("megacloud") || host.includes("kalelmeh") ||
      host.includes("moviehab") || host.includes("vidgomax") ||
      host.includes("player.akamai") || host.includes("yzzzz") ||
      host.includes("streamcloud") || host.includes("streamhg")
    ) {
      sources = extractStreamwishFamily(html, finalUrl);
    } else if (
      // FileMoon / MoonQ family — covers filemoon.sx, filemoon.to, moonq.com,
      // moonq.cc, filemoon.cc, and other moon/filemoon variants.
      host.includes("filemoon") || host.includes("moonq")
    ) {
      sources = extractFilemoon(html, finalUrl);
    } else if (host.includes("erome")) {
      // EroMe (erome.com and all mirror domains: dev.erome.com, es.erome.com,
      // devfr.erome.com, pt.erome.com, etc.) — albums at /a/{id}, individual
      // videos at /v/{id}. Both contain <source> tags with v\d+.erome.com mp4
      // URLs.
      sources = extractErome(html, finalUrl);
    } else if (host.includes("xhamster")) {
      // xHamster and all mirror domains (xhamster.com, xhamster2.com,
      // xhamster.desi, xhamster3.com, xhamster5.com, xhamster18.com,
      // xhamster.xxx, etc.) — Vue SPA with embedded JSON containing m3u8 URLs.
      sources = extractXhamster(html, finalUrl);
    } else if (host.includes("xvideos") || host.includes("xnxx")) {
      // XVideos + XNXX and all mirror domains (xvideos.com, xvideos2.com,
      // xvideos3.com, xnxx.com, xnxx2.com, xnxx3.com, etc.) — share the same
      // html5player.setVideoUrl* / setVideoHLS pattern.
      sources = extractXvideosFamily(html, finalUrl);
    } else if (host.includes("pornhub") || host.includes("redtube") || host.includes("youporn")) {
      // Pornhub network (pornhub.com, redtube.com, youporn.com) and their
      // mirror domains (pornhubpremium.com, redtube.com.br, etc.) — share the
      // flashvars_{id} JSON blob with "mediaDefinitions" array.
      sources = extractPornhubNetwork(html, finalUrl);
    } else if (host.includes("eporner")) {
      // Eporner (eporner.com) — XHR API at /xhr/video/{vid}?hash={transformed}
      // returns real CDN MP4 URLs (480p/360p/240p). The hash is extracted
      // from EP.video.player.hash in the page JS and transformed base-16→36.
      sources = await extractEporner(html, finalUrl);
    } else if (host.includes("drtuber")) {
      // DrTuber (drtuber.com, m.drtuber.desi) — /play/{videoId} returns the
      // actual xcdn.drtuber.desi MP4 URL with a time-limited token.
      sources = await extractDrtuber(html, finalUrl);
    } else if (host.includes("xozilla")) {
      // Xozilla (xozilla.xxx) — /get_file/23/{hash}/{id}/{id}.mp4/ URLs
      // redirect to ahcdn.com CDN. Skip /get_file/1/ (preview GIFs).
      sources = extractXozilla(html, finalUrl);
    } else if (host.includes("porndr")) {
      // PornDr (porndr.com) — /get_file/{n}/{hash}/{id}/{id}_{quality}.mp4/?v-acctoken=...
      // URLs redirect to ahcdn.com CDN. Requires full video page as referer.
      sources = await extractPorndr(html, finalUrl);
    } else if (host.includes("ukdevilz")) {
      // ukdevilz (ukdevilz.com) — JW Player setup JSON contains "file"
      // entries pointing to cdn.pvvstream.pro MP4 files with signed secure=
      // tokens. The page also has a fake /videofile/{id}.mp4 placeholder
      // (returns 404) and related-video URLs — both must be skipped.
      sources = extractUkdevilz(html, finalUrl);
    } else if (host.includes("vids.st") || host === "vids.st") {
      // vids.st — HLS streaming site. The CDN (cdn.vids.st) is IP/geo-
      // restricted and returns 404 for our server IP, so we return an
      // embeddable iframe (https://vids.st/e/{id}) that the user's browser
      // loads directly. Also returns the raw m3u8 as a direct fallback.
      sources = extractVidsSt(html, finalUrl);
    } else if (host.includes("spankbang")) {
      // SpankBang — Cloudflare "Just a moment..." interstitial on all pages.
      // Cannot extract server-side; surface as iframe.
      sources = extractCloudflareIframe(finalUrl, "Open page · Cloudflare challenge required");
    } else if (
      // TrafficStars network — fully Vue SPA with bot detection. The page
      // returns only an ad-config blob on curl fetch; real video URLs are
      // loaded via XHR after the SPA boots. Cannot bypass server-side.
      host.includes("txxx") || host.includes("hdzog") ||
      host.includes("upornia") || host.includes("tubepornclassic") ||
      host.includes("voyeurhit") || host.includes("momvids") ||
      host.includes("shemalez") || host.includes("txxx.tube")
    ) {
      sources = extractCloudflareIframe(finalUrl, "Open page · bot-protected SPA");
    } else if (
      // VOE family — VOE.sx and unblock mirror domains (voeunblk1.com,
      // voeunblk2.com, voeunblock1.net, voeunblock2.net, voe-unblock.com,
      // voeunblk3.com, etc.) — heavily obfuscated JS-based page. Surface as
      // iframe so the user's browser can run the obfuscated player code.
      host.includes("voe.sx") || host.includes("voeunblk") ||
      host.includes("voeunblock") || host.includes("voe-unblock")
    ) {
      sources = extractCloudflareIframe(finalUrl, "Open VOE page (JS-protected)");
    } else if (
      // Upstream — upstream.to and mirror domains. Cloudflare-protected.
      host.includes("upstream.to") || host.includes("upstream")
    ) {
      sources = extractCloudflareIframe(finalUrl, "Open page · Cloudflare challenge required");
    } else if (
      // Send.cm — file hosting site. Cloudflare-protected.
      host.includes("send.cm") || host.includes("send.now")
    ) {
      sources = extractCloudflareIframe(finalUrl, "Open page · Cloudflare challenge required");
    } else if (
      // Vidmoly — video hosting. Bot-protected.
      host.includes("vidmoly")
    ) {
      sources = extractCloudflareIframe(finalUrl, "Open page · bot-protected");
    } else if (
      // StreamSB / StreamLare — video hosting. Bot-protected.
      host.includes("streamsb") || host.includes("streamlare") ||
      host.includes("sbface") || host.includes("sbplay")
    ) {
      sources = extractCloudflareIframe(finalUrl, "Open page · bot-protected");
    } else if (
      // KrakenFiles — Cloudflare Turnstile on download POST endpoint.
      host.includes("krakenfiles") || host.includes("krakencloud")
    ) {
      sources = extractCloudflareIframe(finalUrl, "Open page · Turnstile captcha required");
    } else if (
      // UpFiles — Cloudflare-protected with counter + Turnstile.
      host.includes("upfiles") || host.includes("upfilesgo")
    ) {
      sources = extractCloudflareIframe(finalUrl, "Open page · Turnstile captcha required");
    } else if (
      // YouTube — video pages. We extract videoId + provide embed iframe
      // + thumbnail. The signature cipher can't be decoded server-side.
      host.includes("youtube.com") || host.includes("youtu.be") ||
      host.includes("youtube-nocookie.com")
    ) {
      sources = extractYouTube(html, finalUrl);
    } else if (
      // Facebook — videos, reels, watch. Login-walled.
      host.includes("facebook.com") || host.includes("fb.watch") ||
      host.includes("fb.com")
    ) {
      sources = extractFacebook(html, finalUrl);
    } else if (
      // Instagram — reels, posts, TV. Login-walled.
      host.includes("instagram.com") || host.includes("instagr.am")
    ) {
      sources = extractInstagram(html, finalUrl);
    } else if (
      // Telegram — t.me/{channel}/{postId}. Embed endpoint exposes og:video
      // for video messages.
      host === "t.me" || host.endsWith(".t.me") ||
      host.includes("telegram.me") || host.includes("telegram.org")
    ) {
      sources = await extractTelegram(html, finalUrl);
    } else if (
      // VK — Russian social network. Bot-protected SPA.
      host.includes("vk.com") || host.includes("vkontakte.ru") ||
      host.includes("userapi.com")
    ) {
      sources = extractVK(html, finalUrl);
    } else if (
      // X.com / Twitter — login-walled SPA. og:image always public.
      host === "x.com" || host.endsWith(".x.com") ||
      host.includes("twitter.com") || host.includes("twimg.com")
    ) {
      sources = extractXCom(html, finalUrl);
    } else if (
      // Threads — Meta's text platform. Vue SPA.
      host.includes("threads.net") || host.includes("threads.com") ||
      host.includes("threads.instagram.com")
    ) {
      sources = extractThreads(html, finalUrl);
    }
    // Content-based fallbacks: even when the host is unknown, detect known
    // page structures. This auto-detects new mirror domains and white-labels.
    if (!sources) {
      // Morencius / VidHide embed pattern: packer → var links = {hls4,hls3,hls2}
      // Used by minochinos.com (which embeds morencius.com) and many other
      // "front" pages that iframe to a morencius/vidhide host.
      const decoded = decodePacker(html);
      if (decoded && /var\s+links\s*=\s*\{[^}]*hls[234]/.test(decoded)) {
        sources = extractMorenciusFamily(html, finalUrl);
      }
    }
    if (!sources) {
      // DoodStream clone pattern: i.doodcdn.io asset reference + /d/ or /e/ URL.
      // Returns iframe-type sources (open in new tab — captcha required).
      if (
        html.includes("doodcdn.io") ||
        /\/dood\?op=/.test(html) ||
        /DoodStream\.com/i.test(html)
      ) {
        sources = extractDoodstreamClone(html, finalUrl);
      }
    }
    // Content-based fallback: if no host matched but the page looks like a
    // StreamTape clone (signature ideoooolink div + JS get_video literal),
    // run the StreamTape extractor. This auto-detects new mirror domains.
    if (!sources && looksLikeStreamtapePage(html)) {
      sources = extractStreamtape(html, finalUrl);
    }
    // Content-based fallback: detect EroMe video pages by their signature
    // <source src="...erome.com/...mp4" type='video/mp4' label='HD' res='720'>
    // pattern, even when the host is a mirror we don't have in the dispatch.
    if (!sources && /<source[^>]+src=["'][^"']+\.erome\.com\/[^"']+\.mp4["']/i.test(html)) {
      sources = extractErome(html, finalUrl);
    }
    // Content-based fallback: detect xvideos/xnxx pages by their signature
    // html5player.setVideoUrl* / setVideoHLS pattern, even when the host is
    // a mirror we don't have in the dispatch.
    if (!sources && /html5player\.setVideo(Url|HLS)\s*\(/i.test(html)) {
      sources = extractXvideosFamily(html, finalUrl);
    }
    // Content-based fallback: detect pornhub/redtube/youporn pages by their
    // signature "mediaDefinitions" JSON array.
    if (!sources && /"mediaDefinitions"\s*:\s*\[/.test(html)) {
      sources = extractPornhubNetwork(html, finalUrl);
    }
    // Content-based fallback: detect xhamster pages by their xhcdn.com m3u8 URLs.
    if (!sources && /[^"'\s<>()\\]+?\.xhcdn\.com\/[^"'\s<>()\\]*?\.m3u8/i.test(html)) {
      sources = extractXhamster(html, finalUrl);
    }
    // Content-based fallback: detect eporner pages by their EP.video.player config.
    if (!sources && /EP\.video\.player\.(vid|hash)\s*=/.test(html)) {
      sources = await extractEporner(html, finalUrl);
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
