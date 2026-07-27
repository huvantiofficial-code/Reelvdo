import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Cache the result so we only probe `curl` once per process. On serverless
// platforms (Vercel, etc.) the `curl` binary is typically unavailable, so we
// fall back to the native `fetch` implementation in curl-fetch / curl-stream.
let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;

/**
 * Detect whether the system `curl` binary is available. The check runs once
 * and the result is cached for the lifetime of the process.
 *
 * `curl` is preferred because its TLS fingerprint bypasses many Cloudflare /
 * Akamai bot checks that Node's native `fetch` fails. When it is missing
 * (e.g. Vercel serverless), callers transparently fall back to `fetch`.
 */
export async function isCurlAvailable(): Promise<boolean> {
  if (cached !== null) return cached;
  if (pending) return pending;
  pending = (async () => {
    try {
      await execFileAsync("curl", ["--version"], { timeout: 3000 });
      cached = true;
    } catch {
      cached = false;
    }
    pending = null;
    return cached;
  })();
  return pending;
}

/** True when running on Vercel's serverless platform. */
export const isVercel = !!process.env.VERCEL;
