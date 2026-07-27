// Shared types for the video extraction tool.

export type MediaType =
  | "mp4"
  | "m3u8"
  | "mpd"
  | "ts"
  | "webm"
  | "mov"
  | "mkv"
  | "image"
  | "iframe"
  | "audio"
  | "unknown";

export interface VideoSource {
  /** Absolute, resolved media URL. */
  url: string;
  /** Detected media type. */
  type: MediaType;
  /** Human-readable quality label, e.g. "1080p". */
  quality?: string;
  /** Short label for display. */
  label?: string;
  /** File extension when known. */
  ext?: string;
  /** Estimated file size, if available. */
  size?: string;
  /** Whether the stream is a master playlist with variants. */
  isMaster?: boolean;
  /** Original page URL the source was extracted from (for token refresh). */
  pageUrl?: string;
}

export interface ExtractMeta {
  title?: string;
  thumbnail?: string;
  description?: string;
  host?: string;
  favicon?: string;
}

export interface ExtractResult {
  ok: boolean;
  sources: VideoSource[];
  meta?: ExtractMeta;
  /** The final URL after redirects. */
  finalUrl?: string;
  error?: string;
  /** Raw HTML length for debugging. */
  htmlLength?: number;
  /** Time taken in ms. */
  took?: number;
}

export const QUALITY_ORDER = [
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
  "240p",
  "144p",
];
