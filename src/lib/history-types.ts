// Types for the persisted fetch history (DB row shape).

import type { MediaType } from "./types";

export interface HistoryItem {
  id: string;
  url: string;
  type: string;
  quality?: string | null;
  label?: string | null;
  ext?: string | null;
  size?: string | null;
}

export interface HistoryEntry {
  id: string;
  url: string;
  host: string;
  title: string | null;
  thumbnail: string | null;
  count: number;
  status: string;
  error: string | null;
  tookMs: number | null;
  createdAt: string;
  items: HistoryItem[];
}

export interface HistoryResponse {
  ok: boolean;
  items: HistoryEntry[];
  error?: string;
}

export function mediaTypeFromString(t: string): MediaType {
  switch (t) {
    case "mp4":
    case "m3u8":
    case "mpd":
    case "ts":
    case "webm":
    case "mov":
    case "mkv":
    case "image":
    case "iframe":
    case "audio":
    case "unknown":
      return t;
    default:
      return "unknown";
  }
}
