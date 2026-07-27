import { execFile } from "child_process";
import { promisify } from "util";
import { curlStream } from "./curl-stream";
import { isCurlAvailable } from "./curl-available";

const execFileAsync = promisify(execFile);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Browser-like default headers applied to every request (curl or fetch). */
function defaultHeaders(referer: string): Record<string, string> {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    referer,
    "user-agent": UA,
  };
}

export interface CurlResult {
  text: string;
  finalUrl: string;
  status: number;
  contentType: string;
  ok: boolean;
}

export interface CurlBufferResult {
  buffer: Buffer;
  status: number;
  contentType: string;
  ok: boolean;
}

/** Fetch a URL and return the body as a Buffer (for binary data). */
export async function curlFetchBuffer(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<CurlBufferResult> {
  const r = await curlStream(url, { headers: opts.headers, timeoutMs: opts.timeoutMs });
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return {
    buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))),
    status: r.status,
    contentType: r.headers["content-type"] || "",
    ok: r.status >= 200 && r.status < 300,
  };
}

/**
 * Native `fetch` fallback used when the `curl` binary is unavailable (e.g. on
 * Vercel serverless). Loses the Cloudflare-bypassing TLS fingerprint but keeps
 * the app fully functional for non-protected hosts. Returns the same shape as
 * `curlFetch`.
 */
async function fetchFallback(
  url: string,
  opts: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number } = {}
): Promise<CurlResult> {
  const timeoutMs = opts.timeoutMs ?? 25000;
  let referer = url;
  try {
    referer = new URL(url).origin + "/";
  } catch {
    // keep
  }
  const headers: Record<string, string> = defaultHeaders(referer);
  if (opts.headers) Object.assign(headers, opts.headers);

  const method = opts.method || "GET";
  const init: RequestInit = { method, headers, redirect: "follow" };
  if (method === "POST" && opts.body !== undefined) init.body = opts.body;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // @ts-expect-error — Node's RequestInit.signal accepts AbortSignal.
  init.signal = controller.signal;

  try {
    const resp = await fetch(url, init);
    const text = method === "HEAD" ? "" : await resp.text();
    return {
      text,
      finalUrl: resp.url || url,
      status: resp.status,
      contentType: resp.headers.get("content-type") || "",
      ok: resp.ok,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL using the system `curl` binary. curl's TLS fingerprint passes
 * many Cloudflare/Akamai bot checks that Node's fetch fails. Returns the
 * decoded body text, final URL (after redirects), status, and content-type.
 */
export async function curlFetch(
  url: string,
  opts: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number } = {}
): Promise<CurlResult> {
  // When curl is unavailable (e.g. Vercel serverless), use the native fetch
  // fallback so extraction keeps working without the Cloudflare bypass.
  if (!(await isCurlAvailable())) return fetchFallback(url, opts);

  const timeoutMs = opts.timeoutMs ?? 25000;
  const args: string[] = [
    "-sS", // silent but show errors
    "-L", // follow redirects
    "--compressed", // auto-decompress gzip/deflate/br
    "-4", // force IPv4 — keeps the source IP stable across requests (some
         // hosts bind one-time tokens to the requester's IP).
    "--max-time", String(Math.ceil(timeoutMs / 1000)),
    "--connect-timeout", "15",
    "-A", UA,
    "-H", "accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "-H", "accept-language: en-US,en;q=0.9",
    "-H", "sec-ch-ua: \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
    "-H", "sec-ch-ua-mobile: ?0",
    "-H", "sec-ch-ua-platform: \"Windows\"",
    "-H", "sec-fetch-dest: document",
    "-H", "sec-fetch-mode: navigate",
    "-H", "sec-fetch-site: none",
    "-H", "sec-fetch-user: ?1",
    "-H", "upgrade-insecure-requests: 1",
    "-o", "-", // body to stdout
    "-w", "\n__CURL_META__\n%{http_code}\n%{url_effective}\n%{content_type}", // write meta after body
  ];

  // Set referer to target origin by default (helps with hotlink protection).
  let origin = url;
  try {
    origin = new URL(url).origin + "/";
  } catch {
    // keep
  }
  args.push("-H", `referer: ${origin}`);

  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      args.push("-H", `${k}: ${v}`);
    }
  }
  if (opts.method === "POST" && opts.body !== undefined) {
    // Pass body as a direct argument (execFile does not invoke a shell, so
    // this is safe from injection). Avoids stdin-piping quirks.
    args.push("-X", "POST", "--data-binary", opts.body);
  } else if (opts.method === "HEAD") {
    // HEAD: fetch headers only. We use -I which makes curl print headers to
    // stdout (and skip the body). The text returned is the raw headers.
    args.push("-I");
  } else if (opts.method && opts.method !== "GET") {
    args.push("-X", opts.method);
  }

  // The URL must come as the final positional argument.
  args.push(url);

  let stdout: string;
  try {
    const res = await execFileAsync("curl", args, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    stdout = res.stdout;
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number | string };
    if (err.stdout) {
      stdout = err.stdout;
    } else {
      throw new Error(`curl failed: ${err.stderr || err.code || "unknown"}`);
    }
  }

  // Split body and meta using our sentinel.
  const sentinel = "\n__CURL_META__\n";
  const idx = stdout.lastIndexOf(sentinel);
  let text = stdout;
  let status = 200;
  let finalUrl = url;
  let contentType = "";
  if (idx >= 0) {
    text = stdout.slice(0, idx);
    const meta = stdout.slice(idx + sentinel.length).split("\n");
    status = parseInt(meta[0] || "0", 10) || 0;
    finalUrl = meta[1] || url;
    contentType = meta[2] || "";
  }

  return { text, finalUrl, status, contentType, ok: status >= 200 && status < 300 };
}

/** Quick check whether a response body is a Cloudflare challenge page.
 *  Only flags actual interstitial challenge pages, not normal Cloudflare-served pages. */
export function isCloudflareChallenge(text: string, contentType: string): boolean {
  if (!contentType.includes("text/html")) return false;
  // The canonical interstitial challenge has this exact title.
  if (/<title>[^<]*Just a moment[^<]*<\/title>/i.test(text)) return true;
  // Explicit browser-verification form.
  if (text.includes("cf-browser-verification")) return true;
  // DDoS-Guard / similar "checking your browser" interstitials.
  if (/checking your browser/i.test(text) && /challenge/i.test(text)) return true;
  return false;
}
