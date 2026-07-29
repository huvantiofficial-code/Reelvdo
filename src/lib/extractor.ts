import { load, type CheerioAPI } from "cheerio";
import type { ExtractResult, ExtractMeta, MediaType, VideoSource } from "./types";
import { trySiteExtractor, decodePacker } from "./site-extractors";
import { curlFetch, isCloudflareChallenge } from "./curl-fetch";

/** Media URL patterns to scan for in raw HTML / JS. */
const MEDIA_REGEX =
  /https?:\/\/[^\s"'<>\x60\\)]+?\.(?:m3u8|mpd|mp4|webm|mkv|mov|m4v|avi|ts|mp3|m4a|aac|ogg|wav|m3u)(?:\?[^\s"'<>\x60\\)]*)?/gi;

const M3U8_REGEX = /\.m3u8(\?|$)/i;
const MPD_REGEX = /\.mpd(\?|$)/i;
const TS_REGEX = /\.ts(\?|$)/i;

function classify(url: string): MediaType {
  const u = url.toLowerCase().split("?")[0];
  if (M3U8_REGEX.test(url)) return "m3u8";
  if (MPD_REGEX.test(url)) return "mpd";
  if (TS_REGEX.test(url)) return "ts";
  if (u.endsWith(".mp4") || u.endsWith(".m4v")) return "mp4";
  if (u.endsWith(".webm")) return "webm";
  if (u.endsWith(".mov")) return "mov";
  if (u.endsWith(".mkv")) return "mkv";
  if (u.endsWith(".mp3") || u.endsWith(".m4a") || u.endsWith(".aac") || u.endsWith(".ogg") || u.endsWith(".wav"))
    return "audio";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg") || u.endsWith(".png") || u.endsWith(".webp") || u.endsWith(".gif"))
    return "image";
  return "unknown";
}

function classifyFromCT(ct: string): MediaType {
  const c = ct.toLowerCase();
  if (c.includes("mpegurl") || c.includes("m3u8")) return "m3u8";
  if (c.includes("dash+xml")) return "mpd";
  if (c.includes("mp2t")) return "ts";
  if (c.includes("webm")) return "webm";
  if (c.startsWith("audio/")) return "audio";
  if (c.startsWith("video/")) return "mp4";
  return "mp4";
}

function ctToExt(ct: string): string | undefined {
  const c = ct.toLowerCase();
  if (c.includes("mpegurl")) return "m3u8";
  if (c.includes("dash+xml")) return "mpd";
  if (c.includes("mp2t")) return "ts";
  if (c.includes("webm")) return "webm";
  if (c.includes("mp4")) return "mp4";
  if (c.startsWith("audio/mpeg")) return "mp3";
  if (c.startsWith("audio/")) return "m4a";
  if (c.startsWith("video/")) return "mp4";
  return undefined;
}

function extOf(url: string): string | undefined {
  const clean = url.split("?")[0].split("#")[0];
  const m = clean.match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toLowerCase() : undefined;
}

/** Resolve a possibly-relative URL against a base. */
export function resolveUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    return u.toString();
  } catch {
    return null;
  }
}

/** Fetch text using curl (passes Cloudflare). Returns text + meta. */
async function fetchText(
  url: string
): Promise<{ text: string; finalUrl: string; status: number; contentType: string }> {
  const r = await curlFetch(url);
  return { text: r.text, finalUrl: r.finalUrl, status: r.status, contentType: r.contentType };
}

/** Decide whether a content-type is a media file (not HTML). */
function isMediaContentType(ct: string): boolean {
  const c = ct.toLowerCase();
  return (
    c.startsWith("video/") ||
    c.startsWith("audio/") ||
    c.includes("mpegurl") ||
    c.includes("m3u8") ||
    c.includes("dash+xml") ||
    c.includes("mp2t") ||
    c.includes("mp4")
  );
}

/** Extract a useful title from a cheerio doc. */
function extractMeta($: CheerioAPI, finalUrl: string): ExtractMeta {
  const meta: ExtractMeta = { host: safeHost(finalUrl) };
  const ogTitle =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="og:title"]').attr("content") ||
    $("title").first().text();
  if (ogTitle) meta.title = ogTitle.trim().slice(0, 200);
  const ogImage =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="og:image"]').attr("content") ||
    $('meta[property="twitter:image"]').attr("content");
  if (ogImage) meta.thumbnail = resolveUrl(ogImage, finalUrl) || undefined;
  const ogDesc =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content");
  if (ogDesc) meta.description = ogDesc.trim().slice(0, 280);
  const favicon =
    $('link[rel="icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href") ||
    $('link[rel="apple-touch-icon"]').attr("href");
  if (favicon) meta.favicon = resolveUrl(favicon, finalUrl) || undefined;
  return meta;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Compare two URLs ignoring fragment and trailing slash. */
function isSameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin &&
      ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "") &&
      ua.search === ub.search
    );
  } catch {
    return a === b;
  }
}

/** Returns true for hosts that are known to be captcha-protected (Cloudflare
 *  Turnstile, hCaptcha, "Just a moment..." interstitial, WASM-obfuscated,
 *  Vite SPA with bot detection) OR fully SPA-rendered (TrafficStars network)
 *  where curl cannot retrieve the real video page. For these hosts the site
 *  extractor returns an iframe "open page" source so the user can solve the
 *  captcha in their browser. We must NOT early-return on status>=400 or
 *  Cloudflare-challenge detection because the iframe source is still valid. */
function iframeOkForCaptchaHost(originalUrl: string, finalUrl: string): boolean {
  const candidates = [originalUrl, finalUrl].filter(Boolean);
  for (const u of candidates) {
    let h: string;
    try {
      h = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (
      h.includes("spankbang") ||
      h.includes("txxx") ||
      h.includes("hdzog") ||
      h.includes("upornia") ||
      h.includes("tubepornclassic") ||
      h.includes("voyeurhit") ||
      h.includes("momvids") ||
      h.includes("shemalez") ||
      h.includes("txxx.tube")
    ) {
      return true;
    }
  }
  return false;
}

/** De-duplicate sources by URL (ignoring query for grouping where helpful). */
function dedupe(sources: VideoSource[]): VideoSource[] {
  const seen = new Map<string, VideoSource>();
  for (const s of sources) {
    const key = s.url;
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()];
}

/** Parse a master m3u8 to pull out variant streams with quality labels. */
async function expandM3u8(
  url: string,
  depth = 0
): Promise<VideoSource[]> {
  if (depth > 2) return [{ url, type: "m3u8", ext: "m3u8" }];
  try {
    const r = await curlFetch(url, { timeoutMs: 15000 });
    if (!r.ok) return [{ url, type: "m3u8", ext: "m3u8", isMaster: true }];
    const text = r.text;
    const lines = text.split("\n").map((l) => l.trim());
    const variants: VideoSource[] = [];
    let pending: { resolution?: string; bandwidth?: number; codecs?: string } | null = null;
    let hasVariants = false;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        hasVariants = true;
        const res = line.match(/RESOLUTION=([0-9]+x[0-9]+)/i);
        const bw = line.match(/BANDWIDTH=(\d+)/i);
        const codecs = line.match(/CODECS="([^"]+)"/i);
        pending = {
          resolution: res ? res[1] : undefined,
          bandwidth: bw ? parseInt(bw[1], 10) : undefined,
          codecs: codecs ? codecs[1] : undefined,
        };
      } else if (line && !line.startsWith("#") && pending) {
        const abs = resolveUrl(line, url);
        if (abs) {
          const height = pending.resolution
            ? pending.resolution.split("x")[1] + "p"
            : pending.bandwidth
            ? Math.round(pending.bandwidth / 1000) + "k"
            : "stream";
          variants.push({
            url: abs,
            type: "m3u8",
            ext: "m3u8",
            quality: height,
            label: `${height}${pending.resolution ? ` · ${pending.resolution}` : ""}`,
          });
        }
        pending = null;
      }
    }
    if (hasVariants && variants.length) {
      // Sort by quality desc.
      variants.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
      return variants;
    }
    // It's a media playlist (single quality).
    return [{ url, type: "m3u8", ext: "m3u8", quality: "HLS", label: "HLS stream" }];
  } catch {
    return [{ url, type: "m3u8", ext: "m3u8", isMaster: true }];
  }
}

function qualityRank(q?: string): number {
  if (!q) return 0;
  const m = q.match(/(\d+)p/);
  if (m) return parseInt(m[1], 10);
  const k = q.match(/(\d+)k/i);
  if (k) return parseInt(k[1], 10) / 10;
  return 0;
}

/** Scan raw HTML/script text for media URLs. */
function scanForMediaUrls(text: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  MEDIA_REGEX.lastIndex = 0;
  while ((m = MEDIA_REGEX.exec(text)) !== null) {
    let u = m[0];
    // Trim trailing punctuation that isn't part of the URL.
    u = u.replace(/[.,;:!)\]'"]+$/, "");
    if (u.length > 12) found.add(u);
  }
  return [...found];
}

/** Pull URLs out of common JSON `sources` / `file` patterns. */
function extractFromJsonPatterns(text: string): string[] {
  const urls: string[] = [];
  const patterns = [
    /"(?:file|src|source|url|video|videoUrl|stream|hls|dash|m3u8|mp4)"\s*:\s*"(https?:[^"]+)"/gi,
    /'(?:file|src|source|url|video|videoUrl|stream|hls|dash|m3u8|mp4)'\s*:\s*'(https?:[^']+)'/gi,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(text)) !== null) {
      urls.push(m[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/"));
    }
  }
  return urls;
}

/** Decode common obfuscations found in video-host scripts. */
function decodeObfuscated(text: string): string {
  let out = text;
  // \u002F style escapes
  out = out.replace(/\\u002[fF]/g, "/");
  out = out.replace(/\\u003[aA]/g, ":");
  // Escaped slashes in JSON
  out = out.replace(/\\\//g, "/");
  // HTML entities
  out = out.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/gi, "/");
  return out;
}

export async function extract(rawUrl: string): Promise<ExtractResult> {
  const start = Date.now();
  const url = rawUrl.trim();
  if (!url) return { ok: false, sources: [], error: "Empty URL" };

  try {
    new URL(url);
  } catch {
    return { ok: false, sources: [], error: "Invalid URL" };
  }

  // For known captcha-protected / fully-SPA hosts (spankbang, txxx/hdzog/
  // upornia/tubepornclassic/voyeurhit TrafficStars network), skip the page
  // fetch entirely — curl would either hit a Cloudflare "Just a moment..."
  // interstitial, a 403, or an empty SPA shell. The site extractor returns
  // an iframe "open page" source pointing to the original URL so the user
  // can solve the captcha / wait for the SPA in their own browser.
  if (iframeOkForCaptchaHost(url, url)) {
    const host = safeHost(url) || "";
    try {
      const siteSources = await trySiteExtractor("", url, host);
      if (siteSources && siteSources.length) {
        return {
          ok: true,
          sources: siteSources,
          meta: { host },
          finalUrl: url,
          htmlLength: 0,
          took: Date.now() - start,
        };
      }
    } catch {
      // fall through to normal flow
    }
  }

  // Always fetch first and inspect content-type. A URL ending in .mp4 may
  // actually be an HTML watch page (common on video hosts).
  let html = "";
  let finalUrl = url;
  let status = 0;
  let contentType = "";
  try {
    const r = await fetchText(url);
    html = r.text;
    finalUrl = r.finalUrl;
    status = r.status;
    contentType = r.contentType;
  } catch (e) {
    // If we know this is a captcha host, return an iframe source anyway
    // (curl may have crashed on a redirect loop or timeout).
    if (iframeOkForCaptchaHost(url, url)) {
      const host = safeHost(url) || "";
      try {
        const siteSources = await trySiteExtractor("", url, host);
        if (siteSources && siteSources.length) {
          return {
            ok: true,
            sources: siteSources,
            meta: { host },
            finalUrl: url,
            htmlLength: 0,
            took: Date.now() - start,
          };
        }
      } catch {
        // fall through to error
      }
    }
    return {
      ok: false,
      sources: [],
      error: `Could not reach the page. ${e instanceof Error ? e.message : ""}`.trim(),
      took: Date.now() - start,
    };
  }

  if (status >= 400 && !iframeOkForCaptchaHost(url, finalUrl)) {
    return {
      ok: false,
      sources: [],
      error: `Page returned status ${status}`,
      took: Date.now() - start,
    };
  }

  // Detect Cloudflare-style bot challenge pages.
  if (isCloudflareChallenge(html, contentType) && !iframeOkForCaptchaHost(url, finalUrl)) {
    return {
      ok: false,
      sources: [],
      error: "This site is protected by a bot check that blocks automated access.",
      took: Date.now() - start,
    };
  }

  // If we got a Cloudflare challenge / 4xx on a known captcha host, fall
  // back to an iframe source (the site extractor will produce one).
  if ((status >= 400 || isCloudflareChallenge(html, contentType)) && iframeOkForCaptchaHost(url, finalUrl)) {
    const host = safeHost(finalUrl) || "";
    try {
      const siteSources = await trySiteExtractor(html, finalUrl, host);
      if (siteSources && siteSources.length) {
        return {
          ok: true,
          sources: siteSources,
          meta: { host },
          finalUrl,
          htmlLength: html.length,
          took: Date.now() - start,
        };
      }
    } catch {
      // fall through to media-type check
    }
  }

  // If the response is a media file (not HTML), return it as a direct source.
  const isHtml = contentType.includes("text/html") || contentType.includes("xml") || contentType === "";
  if (!isHtml && isMediaContentType(contentType)) {
    const directType = classify(finalUrl) === "unknown" ? classifyFromCT(contentType) : classify(finalUrl);
    if (directType === "m3u8") {
      const variants = await ExpandMasterM3u8(finalUrl);
      return {
        ok: true,
        sources: variants,
        meta: { host: safeHost(finalUrl) },
        finalUrl,
        htmlLength: html.length,
        took: Date.now() - start,
      };
    }
    return {
      ok: true,
      sources: [
        {
          url: finalUrl,
          type: directType,
          ext: extOf(finalUrl) || ctToExt(contentType),
          label: directType.toUpperCase(),
        },
      ],
      meta: { host: safeHost(finalUrl) },
      finalUrl,
      htmlLength: html.length,
      took: Date.now() - start,
    };
  }

  const $ = load(html);
  const meta = extractMeta($, finalUrl);
  const sources: VideoSource[] = [];

  // 0. Site-specific extractors (host-based dispatch).
  const host = safeHost(finalUrl) || "";
  const siteSources = await trySiteExtractor(html, finalUrl, host);
  if (siteSources && siteSources.length) {
    sources.push(...siteSources);
  }
  // When a site extractor returned authoritative sources, skip the generic
  // raw-HTML media-URL scan. The generic scan reliably produces false
  // positives on video-hosting pages (e.g. StreamTape's <meta og:url>
  // canonical link "https://streamtape.com/v/{id}/{slug}.mp4" looks like a
  // direct video file to the regex but is actually a watch page). The site
  // extractor is the source of truth for known hosts.
  const trustSiteSources = !!(siteSources && siteSources.length);

  // 0b. Decode any eval packer and scan the decoded JS too.
  const packed = decodePacker(html);
  if (packed) {
    const packedScan = [...scanForMediaUrls(packed), ...extractFromJsonPatterns(packed)];
    for (const u of packedScan) {
      const a = resolveUrl(u, finalUrl) || u;
      const t = classify(a);
      if (t !== "unknown" && t !== "image") {
        sources.push({ url: a, type: t, ext: extOf(a), label: t.toUpperCase() });
      }
    }
    // Also pick up file:"..." assignments from decoded JS.
    const fileRe = /file\s*:\s*["']([^"']+)["']/g;
    let fm: RegExpExecArray | null;
    while ((fm = fileRe.exec(packed)) !== null) {
      const a = resolveUrl(fm[1], finalUrl) || fm[1];
      if (/^https?:|^\/\//.test(fm[1])) {
        const t = classify(a);
        if (t !== "unknown" && t !== "image")
          sources.push({ url: a, type: t, ext: extOf(a), label: t.toUpperCase() });
      }
    }
  }

  // 1. <video> / <source> tags
  if (!trustSiteSources) {
    $("video source, video").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (src) {
        const abs = resolveUrl(src, finalUrl);
        if (abs) {
          const t = classify(abs);
          if (t !== "unknown")
            sources.push({ url: abs, type: t, ext: extOf(abs), label: t.toUpperCase() });
        }
      }
    });
  }

  // 2. data-* attributes that often hold stream URLs
  if (!trustSiteSources) {
    $("[data-video],[data-src],[data-hls],[data-source]").each((_, el) => {
      const vals = [$(el).attr("data-video"), $(el).attr("data-hls"), $(el).attr("data-source")];
      for (const v of vals) {
        if (v && /^https?:/.test(v)) {
          const abs = resolveUrl(v, finalUrl);
          if (abs) {
            const t = classify(abs);
            if (t !== "unknown" && t !== "image")
              sources.push({ url: abs, type: t, ext: extOf(abs), label: t.toUpperCase() });
          }
        }
      }
    });
  }

  // 3. <iframe> — collect for recursion (depth-limited). Still collected even
  //    when we trust site sources, because MixDrop's /f/ page embeds an /e/
  //    iframe that the site extractor fetches itself; but for other sites the
  //    iframe may point to a different embed host with its own sources.
  const iframes: string[] = [];
  $("iframe").each((_, el) => {
    const src = $(el).attr("src");
    if (src) {
      const abs = resolveUrl(src, finalUrl);
      if (abs) iframes.push(abs);
    }
  });

  // 4. Scan raw HTML + inline scripts for media URLs. SKIPPED when a site
  //    extractor already returned authoritative sources — the generic regex
  //    matches watch-page URLs that happen to end in .mp4 (e.g. StreamTape's
  //    og:url canonical link) and produces false positives.
  if (!trustSiteSources) {
    const decoded = decodeObfuscated(html);
    const scanned = [...scanForMediaUrls(decoded), ...extractFromJsonPatterns(decoded)];
    for (const u of scanned) {
      const abs = resolveUrl(u, finalUrl) || u;
      const t = classify(abs);
      if (t !== "unknown" && t !== "image") {
        sources.push({ url: abs, type: t, ext: extOf(abs), label: t.toUpperCase() });
      }
    }
  }

  // 5. Recurse into same-host iframes (1 level) to catch embedded players.
  //    SKIPPED when a site extractor already returned authoritative sources
  //    (the extractor handles its own embed-fetching, e.g. MixDrop /f/ -> /e/).
  if (!trustSiteSources) {
    const iframeHost = safeHost(finalUrl);
    for (const iframeUrl of iframes.slice(0, 4)) {
      const ih = safeHost(iframeUrl);
      // Only recurse into iframes that are same-ish host OR known embed hosts.
      // The regex catches common embed-host name fragments; morencius/vidhide
      // hosts are also explicitly listed because minochinos.com and similar
      // front-ends iframe to them.
      const knownEmbedHost =
        /embed|player|video|stream|cdn|play|morencius|vidhide|doodstream|dood\.|filemoon|streamwish|swhoi|filelions|lulu|firestream|mixdrop|odysseusa|vidara/i.test(ih || "") ||
        /\/embed\//.test(iframeUrl);
      if (ih && (ih === iframeHost || knownEmbedHost)) {
        try {
          const r = await fetchText(iframeUrl);
          const ifDecoded = decodeObfuscated(r.text);
          const ifScanned = [...scanForMediaUrls(ifDecoded), ...extractFromJsonPatterns(ifDecoded)];
          const $if = load(r.text);
          $if("video source, video").each((_, el) => {
            const s = $if(el).attr("src");
            if (s) {
              const abs = resolveUrl(s, r.finalUrl);
              if (abs) {
                const t = classify(abs);
                if (t !== "unknown" && t !== "image")
                  sources.push({ url: abs, type: t, ext: extOf(abs), label: t.toUpperCase() });
              }
            }
          });
          for (const u of ifScanned) {
            const abs = resolveUrl(u, r.finalUrl) || u;
            const t = classify(abs);
            if (t !== "unknown" && t !== "image")
              sources.push({ url: abs, type: t, ext: extOf(abs), label: t.toUpperCase() });
          }
        } catch {
          // ignore iframe failures
        }
      }
    }
  }

  // Dedupe & expand m3u8 master playlists. Drop sources that point back to the
  // page itself (a common false positive when the page URL ends in .mp4).
  // Exception: iframe sources intentionally point at the page URL (e.g.
  // DoodStream clones return /e/{filecode} and /d/{filecode} as "open page"
  // sources — the download-page source may equal finalUrl, but that's by
  // design, not a false positive).
  const deduped = dedupe(sources).filter(
    (s) => s.type === "iframe" || !isSameUrl(s.url, finalUrl)
  );
  const expanded: VideoSource[] = [];
  for (const s of deduped) {
    if (s.type === "m3u8") {
      const variants = await ExpandMasterM3u8(s.url);
      // Preserve the originating page URL for token refresh on download.
      if (s.pageUrl) for (const v of variants) if (!v.pageUrl) v.pageUrl = s.pageUrl;
      expanded.push(...variants);
    } else {
      expanded.push(s);
    }
  }

  const final = dedupe(expanded).filter(
    (s) => s.type === "iframe" || !isSameUrl(s.url, finalUrl)
  );
  // Sort: mp4 first, then m3u8 by quality, then others.
  final.sort((a, b) => typeRank(a.type) - typeRank(b.type) || qualityRank(b.quality) - qualityRank(a.quality));

  return {
    ok: final.length > 0,
    sources: final,
    meta,
    finalUrl,
    error: final.length === 0 ? "No video found on this page. The site may require a browser session or use a protected embed." : undefined,
    htmlLength: html.length,
    took: Date.now() - start,
  };
}

async function ExpandMasterM3u8(url: string): Promise<VideoSource[]> {
  try {
    const variants = await expandM3u8(url);
    return variants;
  } catch {
    return [{ url, type: "m3u8", ext: "m3u8", label: "HLS" }];
  }
}

function typeRank(t: MediaType): number {
  switch (t) {
    case "mp4":
      return 0;
    case "m3u8":
      return 1;
    case "mpd":
      return 2;
    case "webm":
      return 3;
    case "mov":
    case "mkv":
      return 4;
    case "ts":
      return 5;
    default:
      return 9;
  }
}
