import { spawn } from "child_process";
import type { Readable } from "stream";
import { isCurlAvailable } from "./curl-available";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface StreamResult {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

export interface StreamOpts {
  headers?: Record<string, string>;
  range?: string | null;
  timeoutMs?: number;
  /** Override the referer (defaults to the target's own origin). Pass the
   *  embedding page URL when a CDN requires hotlink-style referer auth. */
  referer?: string;
  /** When true, skip TLS certificate verification (curl --insecure / Node
   *  NODE_TLS_REJECT_UNAUTHORIZED=0). Needed for sites like vids.st whose
   *  CDN serves an incomplete certificate chain (missing intermediate). */
  insecure?: boolean;
}

function parseHeaders(block: Buffer): {
  status: number;
  headers: Record<string, string>;
} {
  const lines = block.toString("latin1").split(/\r?\n/);
  const sm = lines[0].match(/HTTP\/[\d.]+\s+(\d+)/i);
  const status = sm ? parseInt(sm[1], 10) : 200;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const ci = lines[i].indexOf(":");
    if (ci > 0) {
      headers[lines[i].slice(0, ci).trim().toLowerCase()] = lines[i].slice(ci + 1).trim();
    }
  }
  return { status, headers };
}

/**
 * Native `fetch` streaming fallback used when the `curl` binary is unavailable
 * (e.g. Vercel serverless). Streams the response body with the same browser-like
 * headers that curl sends.
 */
async function fetchStreamFallback(
  url: string,
  opts: StreamOpts = {}
): Promise<StreamResult> {
  const headers: Record<string, string> = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": UA,
  };
  let referer = opts.referer;
  if (!referer) {
    referer = url;
    try {
      referer = new URL(url).origin + "/";
    } catch {
      // keep
    }
  }
  headers["referer"] = referer;
  if (opts.headers) Object.assign(headers, opts.headers);
  if (opts.range) headers["range"] = opts.range;

  // Allow self-signed / incomplete cert chains when the caller requests it.
  // This is set per-request via the Agent override below.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1100000);

  try {
    const fetchOpts: RequestInit & { agent?: unknown } = {
      headers,
      redirect: "follow",
      // @ts-expect-error — Node's RequestInit.signal accepts AbortSignal.
      signal: controller.signal,
    };
    if (opts.insecure) {
      // Disable TLS verification for this request only.
      const https = await import("https");
      const agent = new https.Agent({ rejectUnauthorized: false });
      // @ts-expect-error — Node's fetch accepts a dispatcher/agent in some runtimes.
      fetchOpts.agent = agent;
      // Bun: set the env flag via a header hack is not possible; instead we
      // rely on the dispatcher option. For Node, the agent override works.
      try {
        // @ts-expect-error — undici dispatcher
        fetchOpts.dispatcher = new (await import("undici")).Agent({
          connect: { rejectUnauthorized: false },
        });
      } catch {
        // undici not available — keep the https agent (Node classic).
      }
    }
    const resp = await fetch(url, fetchOpts);
    const h: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      h[k.toLowerCase()] = v;
    });
    const body =
      resp.body ??
      new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    return { status: resp.status, headers: h, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream a URL. Uses the system `curl` binary when available (its TLS
 * fingerprint bypasses bot checks that Node's fetch fails), otherwise falls
 * back transparently to native `fetch` streaming (e.g. on Vercel).
 */
export async function curlStream(
  url: string,
  opts: StreamOpts = {}
): Promise<StreamResult> {
  if (!(await isCurlAvailable())) return fetchStreamFallback(url, opts);
  return curlStreamViaCurl(url, opts);
}

function curlStreamViaCurl(
  url: string,
  opts: StreamOpts = {}
): Promise<StreamResult> {
  const timeoutMs = opts.timeoutMs ?? 1100000; // ~18 min default for large files
  const args: string[] = [
    "-sS", "-L", "--compressed", "-4",
    "--max-time", String(Math.ceil(timeoutMs / 1000)),
    "--connect-timeout", "15",
    "-A", UA,
    "-H", "accept: */*",
    "-H", "accept-language: en-US,en;q=0.9",
    "--dump-header", "-",
    "-o", "-",
  ];
  // Skip TLS verification when the caller requests it (for sites with
  // incomplete certificate chains like vids.st).
  if (opts.insecure) args.push("--insecure");

  // Use an explicit referer override when provided (e.g. the embedding page
  // for CDNs with hotlink protection); otherwise default to the target origin.
  let referer = opts.referer;
  if (!referer) {
    referer = url;
    try {
      referer = new URL(url).origin + "/";
    } catch {
      // keep
    }
  }
  args.push("-H", `referer: ${referer}`);

  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      args.push("-H", `${k}: ${v}`);
    }
  }
  if (opts.range) {
    args.push("-H", `range: ${opts.range}`);
  }
  args.push(url);

  const child = spawn("curl", args, { stdio: ["ignore", "pipe", "ignore"] });
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  };
  const timer = setTimeout(kill, timeoutMs);

  let headerResolve:
    | ((r: { status: number; headers: Record<string, string> }) => void)
    | null = null;
  const headerPromise = new Promise<{
    status: number;
    headers: Record<string, string>;
  }>((resolve) => {
    headerResolve = resolve;
  });

  const stdout = child.stdout as Readable;

  // Header-parsing state machine.
  let buf = Buffer.alloc(0);
  let headersDone = false;
  let bodyStarted = false;

  const tryParseHeaders = (): Buffer | null => {
    // Returns the body remainder if the header/body boundary was found.
    let searchFrom = 0;
    while (true) {
      const idx = buf.indexOf("\r\n\r\n", searchFrom, "latin1");
      if (idx < 0) return null;
      const after = idx + 4;
      // If we don't yet have at least 5 bytes after the boundary, we can't
      // tell whether another HTTP response header block is coming (curl -L
      // following a 302/301/307 redirect) or whether this is the final
      // response whose body starts immediately. Wait for more data to avoid
      // mistakenly treating a redirect's response as final and streaming the
      // next response's HTTP status line as body content (corrupting the
      // video stream with textual HTTP headers).
      if (buf.length < after + 5) return null;
      // Is there another header block (redirect) following?
      if (buf.slice(after, after + 5).toString("latin1") === "HTTP/") {
        searchFrom = after;
        continue;
      }
      // Boundary found. The last header block is everything from the start of
      // the last `HTTP/` line up to idx. Find the last `HTTP/` at/after a CRLF.
      let blockStart = 0;
      const httpIdx = buf.lastIndexOf("HTTP/", idx, "latin1");
      if (httpIdx >= 0) blockStart = httpIdx;
      const block = buf.slice(blockStart, idx);
      const info = parseHeaders(block);
      if (headerResolve) {
        headerResolve(info);
        headerResolve = null;
      }
      headersDone = true;
      return buf.slice(after); // body remainder
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout.on("data", (chunk: Buffer) => {
        if (headersDone && bodyStarted) {
          try {
            controller.enqueue(new Uint8Array(chunk));
          } catch {
            kill();
          }
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        const remainder = tryParseHeaders();
        if (remainder !== null) {
          bodyStarted = true;
          if (remainder.length > 0) {
            try {
              controller.enqueue(new Uint8Array(remainder));
            } catch {
              kill();
            }
          }
        }
      });
      stdout.on("end", () => {
        clearTimeout(timer);
        if (!headersDone) {
          // No body / all-headers; parse whatever we have.
          const info = buf.length ? parseHeaders(buf) : { status: 502, headers: {} };
          if (headerResolve) {
            headerResolve(info);
            headerResolve = null;
          }
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      stdout.on("error", (e) => {
        clearTimeout(timer);
        try {
          controller.error(e);
        } catch {
          // ignore
        }
      });
    },
    cancel() {
      kill();
      clearTimeout(timer);
    },
  });

  child.on("error", () => {
    if (headerResolve) {
      headerResolve({ status: 502, headers: {} });
      headerResolve = null;
    }
  });
  child.on("close", () => {
    clearTimeout(timer);
    if (headerResolve) {
      const info = buf.length ? parseHeaders(buf) : { status: 502, headers: {} };
      headerResolve(info);
      headerResolve = null;
    }
  });

  return headerPromise.then((info) => ({ status: info.status, headers: info.headers, body }));
}
