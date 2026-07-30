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
  // Buffer pending chunks while paused so progress freezes cleanly.
  const pendingRef = useRef<number>(0);

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
    pendingRef.current = 0;
  }, []);

  // Start the download when a source arrives.
  useEffect(() => {
    if (!open || !source) return;
    const filename = basenameFor(source);
    const controller = new AbortController();
    abortRef.current = controller;

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

    // For HLS/DASH, the /api/stream response has no Content-Length (segments
    // are concatenated server-side). Pre-fetch the total via /api/size so we
    // can show a real % bar. This races with the download start - whichever
    // finishes first sets the total; if /api/size fails, we fall back to
    // indeterminate (null total). When HEAD fails for some segments, /api/size
    // also returns a duration-weighted `estimated` total which we use as a
    // fallback so the bar still shows an approximate %.
    let sizeTotal: number | null = null;
    let sizeApprox = false;
    if (source.type === "m3u8" || source.type === "mpd") {
      const sizeUrl = `/api/size?url=${encodeURIComponent(source.url)}${
        source.pageUrl ? `&page=${encodeURIComponent(source.pageUrl)}` : ""
      }`;
      fetch(sizeUrl, { signal: controller.signal })
        .then((r) => r.json())
        .then((data: { ok: boolean; total?: number | null; estimated?: number | null }) => {
          if (data.ok) {
            const measured = typeof data.total === "number" && data.total > 0 ? data.total : null;
            const est = typeof data.estimated === "number" && data.estimated > 0 ? data.estimated : null;
            // Prefer the measured total; fall back to the estimate.
            if (measured) {
              sizeTotal = measured;
              sizeApprox = false;
            } else if (est) {
              sizeTotal = est;
              sizeApprox = true;
            }
            if (sizeTotal) {
              setState((s) => ({
                ...s,
                total: s.total ?? sizeTotal,
                approx: s.total == null ? sizeApprox : s.approx,
              }));
            }
          }
        })
        .catch(() => {
          // ignore - indeterminate progress is fine
        });
    }

    (async () => {
      try {
        // Refresh the source URL before downloading. This ensures we have a
        // fresh, unused token - critical for sites like streamtape that
        // rate-limit tokens (e.g., after the user watched the preview, the
        // original token may be exhausted). For HLS/DASH we keep the original
        // URL (refreshing the master playlist is expensive and rarely needed).
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
            // Refresh failed (abort, network, etc.) - fall back to original.
          }
        }

        // HLS/DASH go through /api/stream (server concatenates segments);
        // mp4/ts go through /api/proxy?download=1. Either way we read the
        // response as a stream and report progress.
        const url = downloadUrlFor(effectiveSource);
        const res = await fetch(url, {
          signal: controller.signal,
          // Don't follow redirects automatically - curl-side already does.
          redirect: "follow",
        });
        if (!res.ok) {
          throw new Error(`Server returned ${res.status}`);
        }
        const totalHeader = res.headers.get("content-length");
        const total = totalHeader ? parseInt(totalHeader, 10) : null;

        setState((s) => ({
          ...s,
          phase: "downloading",
          // Prefer the server's Content-Length (always measured); fall back to
          // /api/size result if available (HLS case) - which may be an estimate.
          total: Number.isFinite(total) && total ? total : (sizeTotal ?? null),
          approx: Number.isFinite(total) && total ? false : sizeApprox,
        }));

        if (!res.body) {
          // No streaming - just bail to a regular download.
          throw new Error("No response body; use direct download");
        }

        // Use the File System Access API when available (Chrome/Edge).
        // This streams directly to disk without storing the file in memory,
        // avoiding the 50-60MB crash that happens when storing chunks in RAM.
        // The writable stream is piped from the fetch response stream.
        type FileSystemFileHandleLike = {
          createWritable: () => Promise<{
            write: (data: Uint8Array | Blob) => Promise<void>;
            close: () => Promise<void>;
          }>;
        };
        type ShowSaveFilePickerFn = (opts: {
          suggestedName?: string;
        }) => Promise<FileSystemFileHandleLike>;

        const _window = window as typeof window & {
          showSaveFilePicker?: ShowSaveFilePickerFn;
        };

        if (typeof _window.showSaveFilePicker === "function") {
          // File System Access API is available — stream directly to disk.
          try {
            const handle = await _window.showSaveFilePicker({
              suggestedName: filename,
            });
            const writable = await handle.createWritable();
            const reader = res.body.getReader();
            let received = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                await writable.write(value);
                received += value.byteLength;
                if (pauseRef.current) {
                  pendingRef.current += value.byteLength;
                } else {
                  const flush = pendingRef.current;
                  pendingRef.current = 0;
                  setState((s) => ({
                    ...s,
                    received: s.received + value.byteLength + flush,
                  }));
                }
              }
            }
            if (pendingRef.current > 0) {
              const flush = pendingRef.current;
              pendingRef.current = 0;
              setState((s) => ({ ...s, received: s.received + flush }));
            }
            await writable.close();
            setState((s) => ({
              ...s,
              phase: "done",
              finishedAt: Date.now(),
              blobUrl: null, // No blob — file was saved directly to disk
            }));
            toast.success("Download complete");
            return;
          } catch (e) {
            // User cancelled the save dialog or FS API failed.
            if ((e as Error).name === "AbortError") {
              setState((s) => ({ ...s, phase: "aborted", finishedAt: Date.now() }));
              return;
            }
            // Fall through to the in-memory blob approach below.
          }
        }

        // Fallback: stream into memory (Blob). This works in Firefox/Safari
        // but may fail for very large files (>200MB) due to memory limits.
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.byteLength;
            // If paused, defer the state update so the bar visibly freezes.
            if (pauseRef.current) {
              pendingRef.current += value.byteLength;
            } else {
              const flush = pendingRef.current;
              pendingRef.current = 0;
              setState((s) => ({
                ...s,
                received: s.received + value.byteLength + flush,
              }));
            }
          }
        }
        // Flush any pending bytes.
        if (pendingRef.current > 0) {
          const flush = pendingRef.current;
          pendingRef.current = 0;
          setState((s) => ({ ...s, received: s.received + flush }));
        }

        // Assemble the blob.
        const blob = new Blob(chunks as BlobPart[], {
          type: res.headers.get("content-type") || "application/octet-stream",
        });
        const blobUrl = URL.createObjectURL(blob);
        setState((s) => ({
          ...s,
          phase: "done",
          finishedAt: Date.now(),
          blobUrl,
        }));
        toast.success("Download ready");
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
      // Cleanup any in-flight controller when dialog closes.
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

  const togglePause = () => {
    pauseRef.current = !pauseRef.current;
    // Force a re-render to flip the icon.
    setState((s) => ({ ...s }));
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
  const etaMs =
    state.total && state.received > 0 && speed > 0
      ? ((state.total - state.received) / speed) * 1000
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

          {/* Error message */}
          {state.phase === "error" && state.error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-destructive">
                  Could not download
                </p>
                <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
                  {state.error}
                </p>
              </div>
            </div>
          )}

          {/* Aborted hint */}
          {state.phase === "aborted" && (
            <p className="text-xs text-muted-foreground">
              Download cancelled. You can close this dialog or retry.
            </p>
          )}

          {/* Done hint */}
          {state.phase === "done" && state.blobUrl && (
            <p className="text-xs text-muted-foreground">
              Your browser has the file ready. Click save to store it on disk.
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
            <Button asChild size="sm" className="gap-1.5">
              <a href={state.blobUrl} download={state.filename}>
                <Download className="h-3.5 w-3.5" />
                Save file
              </a>
            </Button>
          )}

          {state.phase === "done" && !state.blobUrl && (
            <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved to disk
            </div>
          )}

          {(state.phase === "error" || state.phase === "aborted") && (
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
    done: { label: "Ready", icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-400" },
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
