"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Download,
  X,
  Loader2,
  CheckCircle2,
  Info,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { downloadUrlFor } from "@/components/source-card";
import type { VideoSource } from "@/lib/types";
import { toast } from "sonner";

interface DownloadProgressDialogProps {
  source: VideoSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Phase = "idle" | "fetching" | "downloading" | "done" | "error" | "aborted";

interface State {
  phase: Phase;
  received: number;
  total: number | null;
  /** True when `total` is a duration-weighted estimate rather than measured. */
  approx: boolean;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  blobUrl: string | null;
  filename: string;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}

function basenameFor(src: VideoSource): string {
  // Prefer the original filename (e.g. streamtape's slug from /v/{id}/{slug.mp4}).
  // This preserves the user-visible "original file" name on save instead of a
  // generic label-derived name like "mp4_2_5363822546728819944_mp4.mp4".
  if (src.filename) {
    const cleaned = src.filename.replace(/[\\/:*?"<>|]/g, "_").trim();
    if (cleaned) {
      // If the original filename already has an extension, use it as-is.
      // Otherwise, append the detected extension.
      const hasExt = /\.[a-z0-9]{2,5}$/i.test(cleaned);
      if (hasExt) return cleaned;
      return `${cleaned}.${src.ext || "mp4"}`;
    }
  }
  const base = (src.label || src.quality || "video")
    .toString()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (src.type === "m3u8" || src.type === "mpd") {
    return `${base || "video"}.ts`;
  }
  return `${base || "video"}.${src.ext || "mp4"}`;
}

export function DownloadProgressDialog({
  source,
  open,
  onOpenChange,
}: DownloadProgressDialogProps) {
  const [state, setState] = useState<State>({
    phase: "idle",
    received: 0,
    total: null,
    approx: false,
    startedAt: 0,
    finishedAt: null,
    error: null,
    blobUrl: null,
    filename: "video",
  });
  const abortRef = useRef<AbortController | null>(null);
  const pauseRef = useRef(false);
  // Track the byte offset for resume. When the download is paused or fails,
  // we can re-fetch with `Range: bytes={received}-` to continue from here.
  const receivedRef = useRef(0);
  // Accumulate downloaded chunks in memory. When the download completes we
  // build a single Blob and trigger a hidden <a download> click so the file
  // saves to the user's default download folder — NO native "Save As"
  // file-manager prompt is shown (the user explicitly asked us to stop
  // showing that prompt). For very large files this does use memory, but
  // modern browsers handle multi-hundred-MB Blobs fine and the UX is far
  // smoother than repeatedly interrupting the user with a picker dialog.
  const chunksRef = useRef<Uint8Array[]>([]);
  // Track the effective source URL (after refresh) so resume re-fetches
  // the same URL with a Range header.
  const effectiveUrlRef = useRef<string | null>(null);
  // Track the page URL for referer.
  const pageUrlRef = useRef<string | undefined>(undefined);
  // Track whether the source is HLS/DASH. For these, /api/stream concatenates
  // all segments server-side and IGNORES Range headers — so "resume from byte
  // N" is impossible (it would re-stream from segment 0 and append to existing
  // chunks, producing a doubled + corrupted file). For HLS we use the new
  // segment-by-segment downloader (downloadHlsBySegment) which fetches each
  // segment via /api/hls-segment — this survives slow connections (1 Mbps)
  // because each request is small and individually retryable/resumable.
  const isHlsRef = useRef(false);
  // Resolved segment list for HLS downloads (fetched once from
  // /api/hls-segments). Each entry: {url, key?, iv?, duration, size}.
  const hlsSegmentsRef = useRef<
    Array<{
      url: string;
      key?: { method: string; uri: string; iv?: string };
      duration?: number;
      size: number | null;
    }>
  >([]);
  // Index of the next segment to download. On resume after a pause/error,
  // we continue from this index — segments before it are already in
  // chunksRef. This is the key to resumable HLS downloads on slow connections.
  const hlsSegmentIndexRef = useRef(0);

  const reset = useCallback(() => {
    setState({
      phase: "idle",
      received: 0,
      total: null,
      approx: false,
      startedAt: 0,
      finishedAt: null,
      error: null,
      blobUrl: null,
      filename: "video",
    });
    abortRef.current = null;
    pauseRef.current = false;
    receivedRef.current = 0;
    chunksRef.current = [];
    effectiveUrlRef.current = null;
    pageUrlRef.current = undefined;
    isHlsRef.current = false;
    hlsSegmentsRef.current = [];
    hlsSegmentIndexRef.current = 0;
  }, []);

  /** Build a Blob from the accumulated chunks, create an object URL, and
   *  trigger a hidden <a download> click so the browser saves the file to
   *  the user's default download folder. NO "Save As" dialog is shown. */
  const autoSaveBlob = useCallback((filename: string): string => {
    const blob = new Blob(chunksRef.current as BlobPart[], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    // The link must be in the document for Firefox to fire the click.
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    // Clean up the element after a tick (give the browser time to start the
    // navigation). The object URL is revoked later via the blobUrl effect.
    setTimeout(() => {
      try { document.body.removeChild(a); } catch { /* ignore */ }
    }, 1000);
    return url;
  }, []);

  /** Core download loop for NON-HLS sources (direct MP4 / proxied). Fetches
   *  the URL (with optional Range header for resume) and streams chunks into
   *  the in-memory chunks array. Returns when the stream ends, or throws on
   *  error. Respects pauseRef — when paused, it stops reading and returns so
   *  resume can re-fetch with a Range header and continue appending to the
   *  same chunks array.
   *
   *  HLS/DASH sources use `downloadHlsBySegment` instead (segment-by-segment
   *  downloading via /api/hls-segment), which is resilient to slow
   *  connections and supports true per-segment resume. */
  const downloadLoop = async (
    fetchUrl: string,
    controller: AbortController,
    rangeFrom?: number
  ): Promise<"done" | "paused"> => {
    const headers: Record<string, string> = {};
    // Only send a Range header for non-HLS sources. /api/stream (HLS) does
    // not support Range and would ignore it, re-streaming from segment 0.
    if (rangeFrom && rangeFrom > 0 && !isHlsRef.current) {
      headers["range"] = `bytes=${rangeFrom}-`;
    }
    const res = await fetch(fetchUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers,
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Server returned ${res.status}`);
    }

    // If resuming a non-HLS download (206 Partial Content), the
    // Content-Length is the REMAINING bytes, not the total. The total is
    // already set from the initial fetch.
    if (!(rangeFrom && rangeFrom > 0 && res.status === 206)) {
      const totalHeader = res.headers.get("content-length");
      const total = totalHeader ? parseInt(totalHeader, 10) : null;
      if (total && total > 0) {
        setState((s) => (s.total ? s : { ...s, total: total + (rangeFrom || 0) }));
      }
    }

    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    while (true) {
      // Check pause BEFORE reading — if paused, release the reader and return.
      // This stops consuming bandwidth immediately.
      if (pauseRef.current) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return "paused";
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        receivedRef.current += value.byteLength;
        // Always accumulate in memory — on completion we build a Blob and
        // auto-trigger a hidden <a download> click (no Save As prompt).
        chunksRef.current.push(value);
        // Update UI with received bytes. If the stream produces MORE bytes
        // than the pre-fetched estimate (common for HLS when /api/size
        // under-counts segments), bump the total up to reality so the bar
        // never shows >100% and ETA never goes negative.
        setState((s) => {
          let total = s.total;
          if (total && receivedRef.current > total) {
            total = receivedRef.current;
          }
          return {
            ...s,
            received: receivedRef.current,
            total,
            phase: "downloading",
          };
        });
      }
    }
    return "done";
  };

  /** Download an HLS video segment-by-segment. This is the robust download
   *  path for HLS sources — it fetches the playlist once via
   *  /api/hls-segments (getting a JSON list of segment URLs + sizes), then
   *  downloads each segment individually via /api/hls-segment.
   *
   *  Benefits over the old /api/stream approach:
   *  - Each request is small (one segment, ~2–10 MB) so it never hits the
   *    server timeout — works even on 1 Mbps connections.
   *  - Per-segment retry: a failed segment is retried up to 3 times before
   *    giving up, so transient network errors don't kill the whole download.
   *  - True resume: on pause/error/retry we continue from
   *    hlsSegmentIndexRef — segments already downloaded stay in chunksRef.
   *    No restart-from-zero, no doubled size, no corruption.
   *  - Accurate progress: the total is the sum of segment sizes (measured
   *    via HEAD requests), so the bar reflects reality.
   *
   *  `startIndex` lets the caller resume from a specific segment (defaults
   *  to hlsSegmentIndexRef.current, which is updated as we go). */
  const downloadHlsBySegment = useCallback(
    async (controller: AbortController, startIndex?: number) => {
      const pageUrl = pageUrlRef.current;
      // Resolve the segment list once (if not already done).
      if (hlsSegmentsRef.current.length === 0) {
        setState((s) => ({ ...s, phase: "fetching" }));
        const segsUrl = `/api/hls-segments?url=${encodeURIComponent(
          effectiveUrlRef.current || ""
        )}${pageUrl ? `&page=${encodeURIComponent(pageUrl)}` : ""}`;
        const segRes = await fetch(segsUrl, { signal: controller.signal });
        if (!segRes.ok) {
          throw new Error(`Could not load playlist (${segRes.status})`);
        }
        const segData = (await segRes.json()) as {
          ok: boolean;
          segments?: Array<{
            url: string;
            key?: { method: string; uri: string; iv?: string };
            duration?: number;
            size: number | null;
          }>;
          total?: number | null;
          error?: string;
        };
        if (!segData.ok || !segData.segments?.length) {
          throw new Error(segData.error || "No segments found");
        }
        hlsSegmentsRef.current = segData.segments;
        const total = segData.total ?? null;
        if (total && total > 0) {
          setState((s) => ({ ...s, total, approx: false }));
        }
      }

      const segments = hlsSegmentsRef.current;
      const fromIdx =
        startIndex ?? hlsSegmentIndexRef.current;

      setState((s) => ({ ...s, phase: "downloading" }));

      for (let i = fromIdx; i < segments.length; i++) {
        // Check pause before each segment — if paused, record where we are
        // and return so resume can continue from here.
        if (pauseRef.current) {
          hlsSegmentIndexRef.current = i;
          setState((s) => ({ ...s, phase: "downloading" }));
          return "paused";
        }
        // Check abort.
        if (controller.signal.aborted) {
          hlsSegmentIndexRef.current = i;
          return "aborted";
        }

        const seg = segments[i];
        // Build the /api/hls-segment URL with key/iv/index for decryption.
        const params = new URLSearchParams({
          url: seg.url,
          index: String(i + 1),
        });
        if (pageUrl) params.set("page", pageUrl);
        if (seg.key?.uri) {
          params.set("key", seg.key.uri);
          if (seg.key.iv) params.set("iv", seg.key.iv);
        }
        const segmentApiUrl = `/api/hls-segment?${params.toString()}`;

        // Fetch this single segment, retrying up to 3 times on transient
        // errors (network drops, 502s). Each retry has an increasing backoff.
        let segBuf: Uint8Array | null = null;
        let segError: string | null = null;
        for (let attempt = 0; attempt < 3 && !segBuf; attempt++) {
          if (controller.signal.aborted) break;
          try {
            const r = await fetch(segmentApiUrl, {
              signal: controller.signal,
            });
            if (!r.ok) {
              segError = `Segment ${i + 1}: HTTP ${r.status}`;
              if (attempt < 2) {
                await new Promise((res) =>
                  setTimeout(res, 800 * (attempt + 1))
                );
              }
              continue;
            }
            const buf = await r.arrayBuffer();
            if (buf.byteLength === 0) {
              segError = `Segment ${i + 1}: empty response`;
              if (attempt < 2) {
                await new Promise((res) =>
                  setTimeout(res, 800 * (attempt + 1))
                );
              }
              continue;
            }
            segBuf = new Uint8Array(buf);
          } catch (e) {
            if ((e as Error).name === "AbortError") break;
            segError =
              e instanceof Error ? e.message : `Segment ${i + 1} failed`;
            if (attempt < 2) {
              await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
            }
          }
        }

        if (controller.signal.aborted) {
          hlsSegmentIndexRef.current = i;
          return "aborted";
        }

        if (!segBuf) {
          // All retries failed — throw so the caller can show the error.
          // The segment index is saved so "resume" continues from here.
          hlsSegmentIndexRef.current = i;
          throw new Error(
            segError || `Segment ${i + 1} of ${segments.length} failed`
          );
        }

        // Success — accumulate the segment bytes.
        chunksRef.current.push(segBuf);
        receivedRef.current += segBuf.byteLength;
        hlsSegmentIndexRef.current = i + 1;

        // Update the UI. Bump total if this segment was larger than expected
        // or if the estimate was too low.
        setState((s) => {
          let total = s.total;
          if (total && receivedRef.current > total) {
            total = receivedRef.current;
          }
          return {
            ...s,
            received: receivedRef.current,
            total,
            phase: "downloading",
          };
        });
      }

      // All segments downloaded.
      hlsSegmentIndexRef.current = segments.length;
      return "done";
    },
    []
  );

  // Start the download when a source arrives.
  useEffect(() => {
    if (!open || !source) return;
    const filename = basenameFor(source);
    const controller = new AbortController();
    abortRef.current = controller;
    receivedRef.current = 0;
    chunksRef.current = [];
    effectiveUrlRef.current = null;
    pageUrlRef.current = source.pageUrl;
    isHlsRef.current = source.type === "m3u8" || source.type === "mpd";

    setState({
      phase: "fetching",
      received: 0,
      total: null,
      approx: false,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      blobUrl: null,
      filename,
    });

    // For HLS/DASH we no longer use /api/size separately — the segment
    // downloader (/api/hls-segments) returns the total as part of its
    // JSON response. So we skip the separate size pre-fetch for HLS.

    (async () => {
      try {
        // Refresh the source URL before downloading (non-HLS only — HLS
        // sources are resolved fresh by /api/hls-segments).
        let effectiveSource: VideoSource = source;
        if (
          source.pageUrl &&
          source.type !== "m3u8" &&
          source.type !== "mpd"
        ) {
          try {
            const refreshResp = await fetch("/api/refresh", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                url: source.pageUrl,
                preferType: source.type,
              }),
              signal: controller.signal,
            });
            if (refreshResp.ok) {
              const data = (await refreshResp.json()) as {
                ok: boolean;
                source?: { url: string; type: string; filename?: string };
              };
              if (data.ok && data.source?.url) {
                effectiveSource = {
                  ...source,
                  url: data.source.url,
                  filename: data.source.filename || source.filename,
                };
              }
            }
          } catch {
            // Refresh failed - fall back to original.
          }
        }

        // For HLS/DASH: use the source URL directly (the segment downloader
        // will resolve it via /api/hls-segments). For direct/proxied: use
        // the download URL (which may be /api/proxy with refresh params).
        if (isHlsRef.current) {
          effectiveUrlRef.current = source.url;
        } else {
          effectiveUrlRef.current = downloadUrlFor(effectiveSource);
        }

        // Run the appropriate download path.
        const result = isHlsRef.current
          ? await downloadHlsBySegment(controller)
          : await downloadLoop(effectiveUrlRef.current, controller);

        if (result === "paused" || result === "aborted") {
          // Download was paused/aborted — wait for resume. The segment
          // index (for HLS) or received bytes (for direct) are already saved.
          setState((s) => ({ ...s, phase: "downloading" }));
          return;
        }

        // Download complete — build a Blob and auto-trigger a hidden
        // <a download> click so the file saves to the user's default
        // download folder WITHOUT showing a "Save As" picker.
        const blobUrl = autoSaveBlob(filename);
        setState((s) => ({
          ...s,
          phase: "done",
          finishedAt: Date.now(),
          blobUrl,
        }));
        toast.success("Download complete — saved to your downloads");
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setState((s) => ({ ...s, phase: "aborted", finishedAt: Date.now() }));
          return;
        }
        setState((s) => ({
          ...s,
          phase: "error",
          finishedAt: Date.now(),
          error: e instanceof Error ? e.message : "Download failed",
        }));
        toast.error("Download failed");
      }
    })();

    return () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    };
  }, [open, source]);

  // Revoke object URLs on unmount / reset.
  useEffect(() => {
    return () => {
      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
    };
  }, [state.blobUrl]);

  const cancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  };

  const togglePause = async () => {
    const wasPaused = pauseRef.current;
    pauseRef.current = !wasPaused;
    // Force a re-render to flip the icon immediately.
    setState((s) => ({ ...s }));

    if (wasPaused) {
      // Resuming. For HLS/DASH the segment downloader continues from
      // hlsSegmentIndexRef — segments already downloaded stay in chunksRef,
      // so we resume from the next segment (no restart, no doubling). For
      // direct MP4 we use a Range header to continue from receivedRef.
      if (isHlsRef.current) {
        if (abortRef.current) {
          setState((s) => ({ ...s, phase: "downloading", error: null }));
          try {
            const result = await downloadHlsBySegment(abortRef.current);
            if (result === "paused" || result === "aborted") return;
            const blobUrl = autoSaveBlob(state.filename);
            setState((s) => ({
              ...s,
              phase: "done",
              finishedAt: Date.now(),
              blobUrl,
            }));
            toast.success("Download complete — saved to your downloads");
          } catch (e) {
            if ((e as Error).name === "AbortError") return;
            setState((s) => ({
              ...s,
              phase: "error",
              finishedAt: Date.now(),
              error: e instanceof Error ? e.message : "Resume failed",
            }));
            toast.error("Resume failed");
          }
        }
        return;
      }
      // Non-HLS: re-fetch with Range header to continue from receivedRef.
      // The previous downloadLoop returned "paused" and left the chunks
      // array intact. We re-run the loop with a Range header so the server
      // sends only the remaining bytes, which we append to the same array.
      if (effectiveUrlRef.current && abortRef.current) {
        try {
          const result = await downloadLoop(
            effectiveUrlRef.current,
            abortRef.current,
            receivedRef.current
          );
          if (result === "paused") {
            // Paused again — wait for next resume.
            return;
          }
          // Download complete — auto-save the file (no Save As prompt).
          const blobUrl = autoSaveBlob(state.filename);
          setState((s) => ({
            ...s,
            phase: "done",
            finishedAt: Date.now(),
            blobUrl,
          }));
          toast.success("Download complete — saved to your downloads");
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          setState((s) => ({
            ...s,
            phase: "error",
            finishedAt: Date.now(),
            error: e instanceof Error ? e.message : "Resume failed",
          }));
          toast.error("Resume failed");
        }
      }
    }
  };

  const isPaused = pauseRef.current && state.phase === "downloading";
  const pct =
    state.total && state.total > 0
      ? Math.min(100, Math.round((state.received / state.total) * 100))
      : state.phase === "done"
      ? 100
      : 0;

  // Live ETA + speed.
  const elapsedMs = state.finishedAt
    ? state.finishedAt - state.startedAt
    : state.startedAt
    ? Date.now() - state.startedAt
    : 0;
  const speed =
    elapsedMs > 500 && state.received > 0
      ? state.received / (elapsedMs / 1000)
      : 0;
  // ETA is clamped to >= 0 so it never shows a negative "remaining" value
  // (which happened when received exceeded the pre-fetched estimate).
  const etaMs =
    state.total && state.received > 0 && speed > 0
      ? Math.max(0, ((state.total - state.received) / speed) * 1000)
      : null;

  // Tick once a second while downloading so ETA stays fresh.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (state.phase !== "downloading") return;
    const id = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [state.phase]);

  if (!source) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) cancel();
        onOpenChange(o);
        // Reset after the close animation so a re-open starts clean.
        setTimeout(() => {
          if (!o) reset();
        }, 200);
      }}
    >
      <DialogContent className="flex max-h-[calc(100vh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-md sm:max-h-[90vh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:w-full sm:rounded-lg">
        <DialogHeader className="shrink-0 border-b border-border px-3 py-2.5 pr-10 sm:px-4 sm:py-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <Download className="h-4 w-4 text-primary" />
            Download
          </DialogTitle>
          <DialogDescription className="sr-only">
            Download progress for the selected video source
          </DialogDescription>
        </DialogHeader>

        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* Filename + phase */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {state.filename}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {source.type}
                {source.quality ? ` · ${source.quality}` : ""}
              </p>
            </div>
            <PhasePill phase={state.phase} />
          </div>

          {/* Progress bar */}
          <div className="space-y-2">
            {/* Large percentage display */}
            {state.phase === "downloading" && (
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold tabular-nums text-foreground">
                  {pct}%
                </span>
                {state.total && state.received > 0 && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatBytes(state.received)} / {formatBytes(state.total)}
                  </span>
                )}
              </div>
            )}
            <div
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-2.5 w-full overflow-hidden rounded-full bg-primary/15"
            >
              <div
                className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                  state.phase === "fetching"
                    ? "animate-pulse bg-primary/60"
                    : state.phase === "error"
                    ? "bg-destructive"
                    : state.phase === "aborted"
                    ? "bg-muted-foreground"
                    : "bg-primary"
                }`}
                style={{ width: `${state.phase === "fetching" ? 35 : pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
              <span>
                {formatBytes(state.received)}
                {state.total ? (
                  <>
                    {" / "}
                    {formatBytes(state.total)}
                    {state.approx && (
                      <span
                        className="ml-1 rounded border border-primary/30 bg-primary/10 px-1 py-px text-[8px] font-bold text-primary/80"
                        title="Some segment sizes were estimated from duration"
                      >
                        approx
                      </span>
                    )}
                  </>
                ) : ""}
              </span>
              <span>
                {state.phase === "downloading" && speed > 0
                  ? `${formatBytes(speed)}/s`
                  : state.phase === "done"
                  ? `Done in ${formatDuration(elapsedMs)}`
                  : state.phase === "error"
                  ? "Failed"
                  : state.phase === "aborted"
                  ? "Cancelled"
                  : "Starting…"}
              </span>
            </div>
            {state.phase === "downloading" && etaMs !== null && (
              <p className="text-right text-[10px] text-muted-foreground/70">
                ~{formatDuration(etaMs)} remaining
              </p>
            )}
          </div>

          {/* Paused hint — resume continues from the last segment/byte */}
          {isPaused && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                Paused at {formatBytes(receivedRef.current)}. Click resume to
                continue from here — no need to start over.
              </p>
            </div>
          )}

          {/* Error message */}
          {state.phase === "error" && state.error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-destructive">
                  {receivedRef.current > 0
                    ? `Failed at ${formatBytes(receivedRef.current)}`
                    : "Could not download"}
                </p>
                <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
                  {state.error}
                </p>
                {receivedRef.current > 0 && (
                  <p className="mt-1 text-[11px] text-primary">
                    Click resume to continue from where it stopped.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Aborted hint */}
          {state.phase === "aborted" && (
            <p className="text-xs text-muted-foreground">
              {receivedRef.current > 0
                ? `Cancelled at ${formatBytes(receivedRef.current)}. Click resume to continue.`
                : "Download cancelled."}
            </p>
          )}

          {/* Done hint */}
          {state.phase === "done" && state.blobUrl && (
            <p className="text-xs text-muted-foreground">
              File saved to your downloads folder. If the save didn’t start
              automatically, click the button to retry.
            </p>
          )}
        </div>

        {/* Action bar */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3">
          {(state.phase === "downloading" || state.phase === "fetching") && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={togglePause}
                disabled={state.phase === "fetching"}
                className="gap-1.5 text-muted-foreground"
              >
                {isPaused ? (
                  <>
                    <Play className="h-3.5 w-3.5" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="h-3.5 w-3.5" />
                    Pause
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={cancel}
                className="gap-1.5"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            </>
          )}

          {state.phase === "done" && state.blobUrl && (
            <>
              <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Saved to downloads
              </div>
              <Button
                size="sm"
                variant="outline"
                asChild
                className="gap-1.5"
              >
                <a href={state.blobUrl} download={state.filename}>
                  <Download className="h-3.5 w-3.5" />
                  Save again
                </a>
              </Button>
            </>
          )}

          {(state.phase === "error" || state.phase === "aborted") && (
            <>
              {effectiveUrlRef.current && (
                <Button
                  size="sm"
                  variant="default"
                  className="gap-1.5"
                  onClick={async () => {
                    if (isHlsRef.current) {
                      // HLS: resume from the last successful segment.
                      // hlsSegmentIndexRef points to the next segment to
                      // download, so segments before it are already in
                      // chunksRef. No restart, no doubling.
                      const controller = new AbortController();
                      abortRef.current = controller;
                      pauseRef.current = false;
                      setState((s) => ({
                        ...s,
                        phase: "downloading",
                        error: null,
                        finishedAt: null,
                      }));
                      try {
                        const result = await downloadHlsBySegment(controller);
                        if (result === "done") {
                          const blobUrl = autoSaveBlob(state.filename);
                          setState((s) => ({
                            ...s,
                            phase: "done",
                            finishedAt: Date.now(),
                            blobUrl,
                          }));
                          toast.success("Download complete — saved to your downloads");
                        }
                      } catch (e) {
                        if ((e as Error).name === "AbortError") return;
                        setState((s) => ({
                          ...s,
                          phase: "error",
                          finishedAt: Date.now(),
                          error: e instanceof Error ? e.message : "Retry failed",
                        }));
                        toast.error("Retry failed");
                      }
                      return;
                    }
                    // Non-HLS: resume from where we left off — re-fetch
                    // with a Range header and append the remaining bytes.
                    const controller = new AbortController();
                    abortRef.current = controller;
                    pauseRef.current = false;
                    setState((s) => ({
                      ...s,
                      phase: "downloading",
                      error: null,
                      finishedAt: null,
                    }));
                    try {
                      const result = await downloadLoop(
                        effectiveUrlRef.current!,
                        controller,
                        receivedRef.current
                      );
                      if (result === "done") {
                        const blobUrl = autoSaveBlob(state.filename);
                        setState((s) => ({
                          ...s,
                          phase: "done",
                          finishedAt: Date.now(),
                          blobUrl,
                        }));
                        toast.success("Download complete — saved to your downloads");
                      }
                    } catch (e) {
                      setState((s) => ({
                        ...s,
                        phase: "error",
                        finishedAt: Date.now(),
                        error: e instanceof Error ? e.message : "Retry failed",
                      }));
                      toast.error("Retry failed");
                    }
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {isHlsRef.current
                    ? receivedRef.current > 0
                      ? `Resume from ${formatBytes(receivedRef.current)}`
                      : "Retry download"
                    : `Resume from ${formatBytes(receivedRef.current)}`}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                asChild
                className="gap-1.5"
              >
                <a href={downloadUrlFor(source)} download>
                  <Download className="h-3.5 w-3.5" />
                  Direct download
                </a>
              </Button>
            </>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground"
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PhasePill({ phase }: { phase: Phase }) {
  const map: Record<Phase, { label: string; icon: typeof CheckCircle2; cls: string }> = {
    idle: { label: "Idle", icon: Loader2, cls: "text-muted-foreground" },
    fetching: { label: "Starting", icon: Loader2, cls: "text-primary" },
    downloading: { label: "Downloading", icon: Loader2, cls: "text-primary" },
    done: { label: "Saved", icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-400" },
    error: { label: "Failed", icon: Info, cls: "text-destructive" },
    aborted: { label: "Cancelled", icon: X, cls: "text-muted-foreground" },
  };
  const { label, icon: Icon, cls } = map[phase];
  const spin = phase === "fetching" || phase === "downloading";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      <Icon className={`h-3 w-3 ${spin ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}
