import { extract } from "./extractor";
import type { MediaType, VideoSource } from "./types";

/**
 * Re-run extraction for a page URL and return a fresh source URL, preferring
 * the same media type. Used to refresh expired / IP-bound tokens at download
 * time so the download uses a token bound to the current server IP.
 */
export async function refreshSourceUrl(
  pageUrl: string,
  preferType?: MediaType
): Promise<{ url: string; type: MediaType } | null> {
  try {
    const result = await extract(pageUrl);
    if (!result.sources.length) return null;
    // Prefer same type, else first source.
    let pick: VideoSource | undefined;
    if (preferType) {
      pick = result.sources.find((s) => s.type === preferType);
    }
    if (!pick) pick = result.sources[0];
    return { url: pick.url, type: pick.type };
  } catch {
    return null;
  }
}
