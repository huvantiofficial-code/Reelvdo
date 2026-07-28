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
