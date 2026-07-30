"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  ArrowRight,
  ClipboardPaste,
  X,
  Loader2,
  Clapperboard,
  Layers,
  FileVideo,
  Film,
  MonitorPlay,
  Inbox,
  RotateCcw,
  Clock,
  Download,
  Link2,
  ListTree,
  CheckCircle2,
  Star,
  StarOff,
  ArrowDownAz,
  ArrowUpAz,
  FileJson,
  FileSpreadsheet,
  Globe,
  Check,
  ExternalLink,
  BarChart3,
  Share2,
  Lock,
  Info,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  SourceCard,
  SourceCardSkeleton,
} from "@/components/source-card";
import { WatchDialog } from "@/components/watch-dialog";
import { ResultsToolbar } from "@/components/results-toolbar";
import { ResultSummaryCard } from "@/components/result-summary-card";
import { HistoryPanel } from "@/components/history-panel";
import { DownloadProgressDialog } from "@/components/download-progress-dialog";
import { InsightsDialog } from "@/components/insights-dialog";
import { SettingsDrawer } from "@/components/settings-drawer";
import { StatsBadge } from "@/components/stats-badge";
import { AboutDialog } from "@/components/about-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSettings } from "@/hooks/use-settings";
import { toast } from "sonner";
import type { ExtractResult, VideoSource, MediaType } from "@/lib/types";
import { QUALITY_ORDER } from "@/lib/types";
import { cn } from "@/lib/utils";

const TRUST_BADGES = [
  { icon: Clock, label: "Fast extraction", color: "text-emerald-500 dark:text-emerald-400", bg: "bg-emerald-500/10 dark:bg-emerald-400/10", ring: "ring-emerald-500/20" },
  { icon: Lock, label: "Cloudflare-aware", color: "text-emerald-500 dark:text-emerald-400", bg: "bg-emerald-500/10 dark:bg-emerald-400/10", ring: "ring-emerald-500/20" },
  { icon: Eye, label: "Inline preview", color: "text-emerald-500 dark:text-emerald-400", bg: "bg-emerald-500/10 dark:bg-emerald-400/10", ring: "ring-emerald-500/20" },
  { icon: Download, label: "Progress tracking", color: "text-emerald-500 dark:text-emerald-400", bg: "bg-emerald-500/10 dark:bg-emerald-400/10", ring: "ring-emerald-500/20" },
];

const FORMAT_PILLS = [
  { label: "HLS", icon: Layers, hint: "m3u8 streams" },
  { label: "DASH", icon: Layers, hint: "mpd manifests" },
  { label: "MP4", icon: FileVideo, hint: "direct files" },
  { label: "TS", icon: Film, hint: "segments" },
  { label: "WEBM", icon: MonitorPlay, hint: "open video" },
];

const EXAMPLES = [
  { label: "HLS stream", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" },
  { label: "MP4 direct", url: "https://www.w3schools.com/html/mov_bbb.mp4" },
];

/** Quality ranking - higher = better. */
function qualityRank(q?: string): number {
  if (!q) return 999;
  const idx = QUALITY_ORDER.indexOf(q.toLowerCase());
  if (idx >= 0) return idx;
  // Try numeric parsing (e.g. "1080" → 0)
  const num = parseInt(q, 10);
  if (num > 0) {
    if (num >= 2160) return 0;
    if (num >= 1440) return 1;
    if (num >= 1080) return 2;
    if (num >= 720) return 3;
    if (num >= 480) return 4;
    if (num >= 360) return 5;
    return 6;
  }
  // HLS/DASH get high rank (adaptive = best quality available)
  if (q.toLowerCase() === "hls" || q.toLowerCase() === "dash") return -1;
  return 999;
}

/** Sort sources by quality. Embeddable iframes (YouTube /embed/, FB plugin,
 *  IG embed, Telegram embed, VK video_ext, Twitter embed) are preferred as
 *  the "best" source for social platforms since they're the primary playback
 *  method. Captcha-protected iframes (no embeddable flag) are deprioritized. */
function sortByQuality(srcs: VideoSource[], desc = true): VideoSource[] {
  const sorted = [...srcs].sort((a, b) => {
    // Embeddable iframes always come first (they're the playable source for
    // social platforms).
    const aEmbed = a.embeddable ? 1 : 0;
    const bEmbed = b.embeddable ? 1 : 0;
    if (aEmbed !== bEmbed) return bEmbed - aEmbed;
    // Then by quality rank.
    const ra = qualityRank(a.quality || a.label);
    const rb = qualityRank(b.quality || b.label);
    return desc ? ra - rb : rb - ra;
  });
  return sorted;
}

interface Stats {
  totalFetches: number;
  totalSources: number;
  uniqueHosts: number;
}

interface BatchEntry {
  url: string;
  host: string;
  status: "loading" | "done" | "error";
  count: number;
  error?: string;
}

function looksLikeUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Split pasted text into individual valid http(s) URLs. */
function parseUrls(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && looksLikeUrl(s));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

function faviconUrl(host: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [batch, setBatch] = useState<BatchEntry[] | null>(null);
  const [watch, setWatch] = useState<VideoSource | null>(null);
  const [watchOpen, setWatchOpen] = useState(false);
  const [download, setDownload] = useState<VideoSource | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = localStorage.getItem("REEL_FAVORITES");
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const [qualitySort, setQualitySort] = useState<"none" | "desc" | "asc">("desc");
  const inputRef = useRef<HTMLInputElement>(null);
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();

  const toggleFavorite = useCallback((u: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(u)) { next.delete(u); toast.info("Removed from favorites"); }
      else { next.add(u); toast.success("Added to favorites"); }
      try { localStorage.setItem("REEL_FAVORITES", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const runExtract = useCallback(async (target: string) => {
    const trimmed = target.trim();
    if (!trimmed) return;

    // Detect batch mode: 2+ valid URLs separated by whitespace/commas.
    const urls = parseUrls(trimmed);
    const isBatch = urls.length >= 2;

    setLoading(true);
    setResult(null);
    setBatch(null);

    if (isBatch) {
      // Initialize batch status entries.
      const entries: BatchEntry[] = urls.map((u) => ({
        url: u,
        host: hostOf(u),
        status: "loading",
        count: 0,
      }));
      setBatch(entries);

      try {
        const results = await Promise.allSettled(
          urls.map((u) =>
            fetch("/api/extract", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url: u }),
            }).then((r) => r.json() as Promise<ExtractResult>)
          )
        );

        const merged: VideoSource[] = [];
        let meta: ExtractResult["meta"];
        const finalEntries: BatchEntry[] = entries.map((e, i) => {
          const res = results[i];
          if (res.status === "fulfilled" && res.value.ok) {
            const srcs = res.value.sources || [];
            for (const s of srcs) {
              if (!s.pageUrl) s.pageUrl = e.url;
            }
            merged.push(...srcs);
            if (!meta && res.value.meta) meta = res.value.meta;
            return { ...e, status: "done" as const, count: srcs.length };
          }
          const errMsg =
            res.status === "fulfilled"
              ? res.value.error || "No sources"
              : "Request failed";
          return { ...e, status: "error" as const, error: errMsg };
        });
        setBatch(finalEntries);

        const okCount = finalEntries.filter((e) => e.status === "done").length;
        const combined: ExtractResult = {
          ok: merged.length > 0,
          sources: merged,
          meta,
          error: merged.length === 0 ? "No sources found across any URL" : undefined,
        };
        setResult(combined);

        if (merged.length === 0) {
          toast.error("No sources found across any URL");
        } else {
          toast.success(
            `Found ${merged.length} source${merged.length > 1 ? "s" : ""} from ${okCount} URL${okCount > 1 ? "s" : ""}`,
            {
              action: {
                label: "Watch best",
                onClick: () => {
                  setWatch(sortByQuality(merged)[0]);
                  setWatchOpen(true);
                },
              },
            }
          );
          if (settings.autoWatch && merged[0]) {
            setWatch(sortByQuality(merged)[0]);
            setWatchOpen(true);
          }
        }

        // Persist each successful URL to history.
        for (const e of finalEntries) {
          if (e.status === "done" && e.count > 0) {
            const res = results[urls.indexOf(e.url)];
            if (res.status === "fulfilled") {
              try {
                await fetch("/api/history", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ url: e.url, result: res.value }),
                });
              } catch {}
            }
          }
        }
        setHistoryKey((k) => k + 1);
      } catch (e) {
        toast.error("Batch request failed. Please try again.");
        setResult({
          ok: false,
          sources: [],
          error: e instanceof Error ? e.message : "Network error",
        });
      } finally {
        setLoading(false);
      }
      return;
    }

    // Single-URL path.
    setLoading(true);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data: ExtractResult = await res.json();
      setResult(data);
      if (!data.ok || data.sources.length === 0) {
        toast.error(data.error || "No video found on this page");
      } else {
        const sorted = sortByQuality(data.sources);
        toast.success(
          `Found ${data.sources.length} source${data.sources.length > 1 ? "s" : ""}`,
          {
            action: sorted.length > 0 ? {
              label: "Watch best",
              onClick: () => {
                setWatch(sorted[0]);
                setWatchOpen(true);
              },
            } : undefined,
          }
        );
        if (settings.autoWatch && sorted[0]) {
          setWatch(sorted[0]);
          setWatchOpen(true);
        }
      }
      try {
        await fetch("/api/history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: trimmed, result: data }),
        });
        setHistoryKey((k) => k + 1);
      } catch {}
    } catch (e) {
      toast.error("Request failed. Please try again.");
      setResult({
        ok: false,
        sources: [],
        error: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setLoading(false);
    }
  }, [settings.autoWatch]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runExtract(url);
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text);
        inputRef.current?.focus();
      }
    } catch {
      toast.error("Clipboard access blocked by browser");
    }
  };

  const openWatch = (s: VideoSource) => {
    // iframe sources are HTML pages (e.g. DoodStream clones with captcha).
    // They can't be played in our video player - open in a new tab instead.
    if (s.type === "iframe") {
      if (typeof window !== "undefined") {
        window.open(s.url, "_blank", "noopener,noreferrer");
        toast.info("Opened source page in a new tab", {
          description: "Solve the captcha on the source site to watch or download.",
        });
      }
      return;
    }
    setWatch(s);
    setWatchOpen(true);
  };

  const openDownload = (s: VideoSource) => {
    // iframe sources: open in a new tab - we can't proxy a captcha-protected
    // HTML page through the download stream.
    if (s.type === "iframe") {
      if (typeof window !== "undefined") {
        window.open(s.url, "_blank", "noopener,noreferrer");
        toast.info("Opened source page in a new tab", {
          description: "Solve the captcha on the source site to download.",
        });
      }
      return;
    }
    setDownload(s);
    setDownloadOpen(true);
  };

  const reset = useCallback(() => {
    setUrl("");
    setResult(null);
    setBatch(null);
    inputRef.current?.focus();
  }, []);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Auto-focus on mount & read URL search params for PWA shortcut support.
  useEffect(() => {
    inputRef.current?.focus();
    // Wire ?url= query param - enables PWA shortcuts and shareable links.
    try {
      const params = new URLSearchParams(window.location.search);
      const urlParam = params.get("url");
      if (urlParam && looksLikeUrl(urlParam)) {
        setUrl(urlParam);
        // Clean the URL from the browser address bar without triggering a reload.
        window.history.replaceState({}, "", "/");
        // Auto-fetch the provided URL.
        runExtract(urlParam);
      }
    } catch { /* no URL params or invalid */ }
  }, [runExtract]);

  // Fetch stats on mount.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/stats");
        const data = await res.json();
        if (data.ok && data.totalFetches > 0) {
          setStats({
            totalFetches: data.totalFetches,
            totalSources: data.totalSources,
            uniqueHosts: data.uniqueHosts,
          });
        }
      } catch {}
    })();
  }, []);

  // Drag-and-drop handlers.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const raw = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list") || "";
    const droppedUrl = raw.trim();
    if (droppedUrl) {
      setUrl(droppedUrl);
      inputRef.current?.focus();
      const urls = parseUrls(droppedUrl);
      if (urls.length === 1 && looksLikeUrl(urls[0])) {
        runExtract(urls[0]);
      } else if (urls.length >= 2) {
        runExtract(droppedUrl);
      }
    }
  }, [runExtract]);

  const hasResults = !!result && result.sources.length > 0;

  // Apply quality sorting to results
  const displaySources = useMemo(() => {
    if (!result) return [];
    if (qualitySort === "none") return result.sources;
    return sortByQuality(result.sources, qualitySort === "desc");
  }, [result, qualitySort]);

  const poster = result?.meta?.thumbnail;
  const bestSource = hasResults ? sortByQuality(result.sources)[0] : undefined;
  const bestUrl = bestSource?.url;
  // When sources are iframe-type (captcha-protected pages, e.g. playmogo.com
  // DoodStream clones), the "best" source may be a "Watch" page. Provide a
  // separate best-download source that prefers an iframe source labeled
  // "Download" so the Download-best button opens the right page.
  const bestDownloadSource = hasResults
    ? (() => {
        const sources = result.sources;
        // Prefer an iframe source whose quality/label mentions "download".
        const dlIframe = sources.find(
          (s) =>
            s.type === "iframe" &&
            (s.quality === "Download" || /download/i.test(s.label || ""))
        );
        if (dlIframe) return dlIframe;
        // Otherwise fall back to the overall best source.
        return bestSource;
      })()
    : undefined;

  // Live batch-mode detection for the input pill.
  const detectedUrls = useMemo(() => parseUrls(url), [url]);
  const isBatchInput = detectedUrls.length >= 2;

  // URL validation state
  const urlHost = useMemo(() => {
    try {
      if (!url.trim()) return null;
      const u = new URL(url.trim());
      return u.hostname.replace(/^www\./, "");
    } catch { return null; }
  }, [url]);
  const urlValid = useMemo(() => url.trim() && looksLikeUrl(url.trim()), [url]);

  // URL security indicator - HTTPS vs HTTP
  const urlProtocol = useMemo(() => {
    try {
      if (!url.trim()) return null;
      const u = new URL(url.trim());
      return u.protocol === "https:" ? "https" : u.protocol === "http:" ? "http" : null;
    } catch { return null; }
  }, [url]);

  // Share URL - generates a shareable link that auto-fetches
  const shareUrl = useMemo(() => {
    if (!urlValid || !url.trim()) return "";
    return `${window.location.origin}?url=${encodeURIComponent(url.trim())}`;
  }, [url, urlValid]);

  const copyShareUrl = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied! Anyone with this link will auto-fetch the same URL.");
    } catch {
      toast.error("Could not copy share link");
    }
  }, [shareUrl]);

  // Export results
  const exportResults = useCallback((format: "json" | "csv") => {
    if (!result) return;
    const sources = result.sources;
    if (format === "json") {
      const payload = {
        exportedAt: new Date().toISOString(),
        url: url,
        title: result.meta?.title,
        host: result.meta?.host,
        sources: sources.map(s => ({
          url: s.url,
          type: s.type,
          quality: s.quality || null,
          label: s.label || null,
          ext: s.ext || null,
          size: s.size || null,
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `reel-results-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast.success(`Exported ${sources.length} sources as JSON`);
    } else {
      const header = "URL,Type,Quality,Label,Extension,Size\n";
      const rows = sources.map(s =>
        `"${s.url}","${s.type}","${s.quality || ""}","${s.label || ""}","${s.ext || ""}","${s.size || ""}"`
      ).join("\n");
      const blob = new Blob([header + rows], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `reel-results-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast.success(`Exported ${sources.length} sources as CSV`);
    }
  }, [result, url]);

  return (
    <div className="relative flex min-h-screen flex-col noise-overlay">
      {/* Decorative background - multi-layer composition */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 hero-gradient" />
      {/* Grid pattern */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 [background-image:linear-gradient(oklch(0.5_0.02_162/0.03)_1px,transparent_1px),linear-gradient(90deg,oklch(0.5_0.02_162/0.03)_1px,transparent_1px)] [background-size:42px_42px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]"
      />
      {/* Floating orbs - animated gradient blobs */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="animate-orb-1 absolute left-[15%] bottom-[20%] h-[300px] w-[300px] rounded-full bg-primary/5 blur-3xl dark:bg-primary/3" />
        <div className="animate-orb-2 absolute right-[20%] top-[60%] h-[250px] w-[250px] rounded-full bg-primary/4 blur-3xl dark:bg-primary/2" />
        <div className="animate-orb-3 absolute left-[50%] top-[10%] h-[200px] w-[200px] rounded-full bg-primary/3 blur-3xl dark:bg-primary/2" />
      </div>
      {/* Shimmer accent */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 animate-shimmer [background-image:linear-gradient(110deg,transparent_25%,oklch(0.55_0.13_162/0.03)_50%,transparent_75%)] [background-size:200%_100%]"
      />

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <button
            onClick={reset}
            className="group flex items-center gap-2 text-foreground transition-colors btn-press"
            aria-label="Reel home"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-md shadow-primary/25 transition-shadow group-hover:shadow-lg group-hover:shadow-primary/30 group-hover:scale-[1.05]">
              <Clapperboard className="h-4 w-4" />
            </span>
            <span className="text-base font-bold tracking-tight">Reel</span>
            <span className="hidden text-[11px] font-medium text-muted-foreground/70 sm:inline">
              · fetch &amp; download
            </span>
          </button>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Insights"
              title="Insights"
              onClick={() => setInsightsOpen(true)}
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <BarChart3 className="h-4 w-4" />
            </Button>
            <SettingsDrawer
              settings={settings}
              update={updateSettings}
              reset={resetSettings}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="About"
              title="About Reel"
              onClick={() => setAboutOpen(true)}
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <Info className="h-4 w-4" />
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex flex-1 flex-col">
        <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">

          {/* Hero */}
          <section className="animate-fade-up flex flex-col items-center text-center">
            <h1 className="text-balance text-3xl font-bold tracking-tight text-foreground sm:text-4xl lg:text-[2.75rem] leading-[1.05]">
              Fetch video from{" "}
              <span className="animate-gradient-text bg-gradient-to-r from-primary via-primary/80 to-primary/50 bg-clip-text text-transparent">
                any link
              </span>
            </h1>
            <p className="mt-3 max-w-md text-pretty text-sm font-medium text-muted-foreground sm:text-base">
              Paste a URL · watch, copy, or download.
            </p>

            {/* Search bar - drag-drop zone */}
            <form
              onSubmit={onSubmit}
              className="relative mt-7 w-full"
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {/* Drag overlay */}
              {isDragging && (
                <div className="animate-scale-in absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-sm transition-all">
                  <div className="flex items-center gap-2 text-sm font-medium text-primary">
                    <Link2 className="h-5 w-5 animate-dot-pulse" />
                    Drop URL here
                  </div>
                </div>
              )}
              <div className={`group relative flex w-full items-center transition-shadow ${isDragging ? "ring-2 ring-primary/50" : ""}`}>
                {/* URL host favicon + security badge - left side */}
                {urlHost && urlValid && (
                  <div className="absolute left-2 flex items-center gap-1">
                    {/* Security badge - HTTPS/HTTP indicator */}
                    {urlProtocol === "https" && (
                      <TooltipProvider delayDuration={300}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                              <Lock className="h-2.5 w-2.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>HTTPS · secure connection</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {urlProtocol === "http" && (
                      <TooltipProvider delayDuration={300}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-destructive/15 text-destructive">
                              <Info className="h-2.5 w-2.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>HTTP · unencrypted connection</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    <img
                      src={faviconUrl(urlHost)}
                      alt=""
                      className="h-4 w-4 rounded-sm"
                      loading="lazy"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  </div>
                )}
                <Input
                  ref={inputRef}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="Paste a video or page URL"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className={cn(
                    "url-input-focus h-12 rounded-lg border-border/80 bg-card pr-20 pl-3 text-sm font-medium shadow-sm placeholder:text-muted-foreground/70",
                    urlHost && urlValid && "pl-10"
                  )}
                />
                {/* URL valid indicator */}
                {url.trim() && (
                  <div className="absolute left-2 top-1/2 -translate-y-1/2 hidden">
                    {urlValid ? (
                      <Check className="h-3 w-3 text-primary/70" />
                    ) : (
                      <Info className="h-3 w-3 text-muted-foreground/40" />
                    )}
                  </div>
                )}
                <div className="absolute right-1.5 flex items-center gap-0.5">
                  {url ? (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label="Clear"
                            onClick={() => setUrl("")}
                            className="h-9 w-9 text-muted-foreground btn-press"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Clear input</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label="Paste from clipboard"
                            onClick={paste}
                            className="h-9 w-9 text-muted-foreground btn-press"
                          >
                            <ClipboardPaste className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Paste from clipboard</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {/* Divider */}
                  <span aria-hidden className="mx-0.5 h-5 w-px bg-border/70 hidden sm:block" />
                  {/* Share URL button */}
                  {urlValid && !loading && (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label="Share this URL"
                            onClick={copyShareUrl}
                            className="hidden h-9 w-9 text-muted-foreground/50 hover:text-primary btn-press sm:inline-flex"
                          >
                            <Share2 className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Copy share link</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {/* Favorite toggle */}
                  {urlValid && (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={favorites.has(url.trim()) ? "Remove from favorites" : "Add to favorites"}
                            onClick={() => toggleFavorite(url.trim())}
                            className={cn("hidden h-9 w-9 btn-press sm:inline-flex", favorites.has(url.trim()) ? "text-primary" : "text-muted-foreground/50 hover:text-primary")}
                          >
                            {favorites.has(url.trim()) ? (
                              <Star className="h-4 w-4 fill-primary" />
                            ) : (
                              <StarOff className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{favorites.has(url.trim()) ? "In favorites" : "Add to favorites"}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {/* Submit */}
                  <Button
                    type="submit"
                    size="icon"
                    aria-label="Fetch"
                    disabled={loading || !url.trim()}
                    className="submit-glow h-9 w-9 rounded-md bg-gradient-to-br from-primary to-primary/85 text-primary-foreground shadow-md shadow-primary/30"
                  >
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowRight className="h-4 w-4 transition-transform group-focus-within:translate-x-0.5" />
                    )}
                  </Button>
                </div>
              </div>

              {/* URL security line */}
              {urlValid && urlProtocol && !isBatchInput && !loading && (
                <div className="animate-fade-up mt-1.5 flex items-center justify-center gap-2 text-[11px]">
                  {urlProtocol === "https" ? (
                    <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                      <Lock className="h-3 w-3" />
                      HTTPS · {urlHost}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 font-medium text-destructive">
                      <Info className="h-3 w-3" />
                      HTTP · may be blocked
                    </span>
                  )}
                  <span className="text-muted-foreground/40">·</span>
                  <button
                    type="button"
                    onClick={copyShareUrl}
                    className="flex items-center gap-1 font-medium text-primary/70 hover:text-primary btn-press"
                  >
                    <Share2 className="h-3 w-3" />
                    Share
                  </button>
                </div>
              )}
              {/* Batch-mode indicator */}
              {isBatchInput && !loading && (
                <div className="animate-scale-in mt-2 flex items-center justify-center gap-1.5">
                  <ListTree className="h-3.5 w-3.5 text-primary" />
                  <span className="text-[11px] font-medium text-primary">
                    Batch: {detectedUrls.length} URLs
                  </span>
                </div>
              )}
              {/* Batch hint - only when input empty & no results */}
              {!url && !hasResults && !loading && (
                <p className="mt-2 text-center text-[10px] text-muted-foreground/60">
                  Paste multiple URLs for batch mode
                </p>
              )}

              {/* Examples + keyboard hint */}
              {!hasResults && !loading && (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="font-semibold text-foreground/80">Try:</span>
                    {EXAMPLES.map((ex, i) => (
                      <span key={ex.url} className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setUrl(ex.url);
                            runExtract(ex.url);
                          }}
                          className="btn-press rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-semibold text-foreground/70 shadow-sm transition-all hover:border-primary/50 hover:bg-primary/5 hover:text-primary hover:shadow-md hover:shadow-primary/10"
                        >
                          {ex.label}
                        </button>
                        {i < EXAMPLES.length - 1 && (
                          <span className="text-muted-foreground/40">·</span>
                        )}
                      </span>
                    ))}
                  </span>
                  {/* Favorites quick links */}
                  {favorites.size > 0 && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Star className="h-3 w-3 text-primary/70" />
                        <span className="font-semibold text-foreground/80">Favorites:</span>
                        {[...favorites].slice(0, 3).map((fav) => (
                          <button
                            key={fav}
                            type="button"
                            onClick={() => { setUrl(fav); runExtract(fav); }}
                            className="btn-press rounded-full border border-primary/30 bg-primary/8 px-2 py-0.5 text-[11px] font-semibold text-primary shadow-sm transition-all hover:bg-primary/15 hover:shadow-md hover:shadow-primary/15"
                          >
                            {hostOf(fav)}
                          </button>
                        ))}
                      </span>
                    </>
                  )}
                </div>
              )}
            </form>

            {/* Capabilities card */}
            {!hasResults && !loading && (
              <div className="animate-fade-up mt-10 w-full rounded-xl border border-border/70 bg-card/80 p-5 shadow-md shadow-black/[0.03] backdrop-blur-sm dark:bg-card/50 dark:shadow-black/20">
                <div className="flex items-center justify-center gap-2">
                  <span className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent" />
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground">
                    Capabilities
                  </span>
                  <span className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent" />
                </div>
                {/* Trust badges */}
                <div className="animate-stagger mt-4 grid grid-cols-2 gap-x-3 gap-y-2.5 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-x-5">
                  {TRUST_BADGES.map((b) => (
                    <span
                      key={b.label}
                      className="group/badge flex items-center gap-2 text-[11px] font-semibold text-foreground/80 transition-colors sm:flex-wrap"
                    >
                      <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 transition-all group-hover/badge:scale-110 group-hover/badge:shadow-md", b.bg, b.ring)}>
                        <b.icon className={cn("h-3.5 w-3.5 transition-transform", b.color)} />
                      </span>
                      {b.label}
                    </span>
                  ))}
                </div>
                {/* Divider */}
                <div className="my-3.5 flex items-center justify-center">
                  <span className="h-px w-12 bg-border/60" />
                </div>
                {/* Format pills */}
                <div className="animate-stagger flex flex-wrap items-center justify-center gap-1.5">
                  {FORMAT_PILLS.map((p) => (
                    <span
                      key={p.label}
                      title={p.hint}
                      className="group/pill flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-[10px] font-bold text-muted-foreground shadow-sm transition-all hover:border-primary/50 hover:bg-primary/8 hover:text-primary hover:shadow-md hover:shadow-primary/10"
                    >
                      <p.icon className="h-3 w-3 text-primary/70 transition-transform group-hover/pill:scale-110" />
                      {p.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Stats badge */}
            {!hasResults && !loading && stats && stats.totalFetches > 0 && (
              <StatsBadge
                totalFetches={stats.totalFetches}
                totalSources={stats.totalSources}
                uniqueHosts={stats.uniqueHosts}
              />
            )}
          </section>

          {/* History panel */}
          {!hasResults && !loading && (
            <div className="mt-8">
              <HistoryPanel
                onRefetch={runExtract}
                refreshKey={historyKey}
                limit={settings.historyLimit}
              />
            </div>
          )}

          {/* Results */}
          <section className="animate-fade-up mt-8">
            {/* Batch status strip */}
            {batch && batch.length >= 2 && (
              <div className="mb-3 rounded-lg border border-border/60 bg-card/50 p-3 backdrop-blur-sm shadow-sm">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground/80">
                  <ListTree className="h-3.5 w-3.5 text-primary" />
                  Batch progress · {batch.length} URLs
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {batch.map((e) => (
                    <div
                      key={e.url}
                      className={cn(
                        "flex items-center gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-1.5 text-xs transition-colors",
                        e.status === "done" && "border-primary/20 bg-primary/5",
                        e.status === "error" && "border-destructive/20"
                      )}
                    >
                      {e.status === "loading" && (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                      )}
                      {e.status === "done" && (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                      )}
                      {e.status === "error" && (
                        <Info className="h-3.5 w-3.5 shrink-0 text-destructive" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                        {e.host}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {e.status === "loading"
                          ? "…"
                          : e.status === "done"
                            ? `${e.count} src${e.count === 1 ? "" : "s"}`
                            : "failed"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {loading && (
              <div className="animate-fade-up flex flex-col items-center gap-4">
                {/* Extraction progress visualization */}
                <div className="relative flex h-20 w-20 items-center justify-center">
                  <div className="absolute inset-0 rounded-full bg-primary/10 animate-pulse-ring" />
                  <div className="absolute inset-2 rounded-full bg-primary/5 animate-spin" style={{ animationDuration: "3s" }}>
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-primary/40" />
                  </div>
                  <Loader2 className="h-8 w-8 animate-spin text-primary" style={{ animationDuration: "1.5s" }} />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-foreground">
                    Extracting…
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground animate-float">
                    Scanning page &amp; embeds
                  </p>
                </div>
                {/* Skeleton previews */}
                <div className="w-full space-y-2.5 mt-2">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <SourceCardSkeleton key={i} />
                  ))}
                </div>
              </div>
            )}

            {!loading && result && result.sources.length === 0 && (
              <div className="animate-fade-up flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/30 px-6 py-14 text-center backdrop-blur-sm shadow-sm">
                {/* Animated icon */}
                <div className="relative mb-1">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/20 animate-bounce-gentle">
                    <Inbox className="h-7 w-7 text-destructive/50" />
                  </div>
                  <div className="absolute -right-2 -top-2 h-4 w-4 rounded-full bg-destructive/40 animate-dot-pulse" />
                </div>
                <p className="text-base font-semibold text-foreground">
                  No video found
                </p>
                <p className="mt-2 max-w-md text-sm text-muted-foreground leading-relaxed">
                  {result.error || "This page may use a protected embed."}
                </p>
                {/* Suggestion pills */}
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 btn-press"
                    onClick={() => runExtract(url)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Try again
                  </Button>
                  <span className="text-muted-foreground/40">·</span>
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex.url}
                      type="button"
                      onClick={() => { setUrl(ex.url); runExtract(ex.url); }}
                      className="btn-press rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
                {/* Helpful tips */}
                <div className="mt-5 flex items-center gap-2 text-[11px] text-muted-foreground/60">
                  <span>Direct video URLs (.mp4, .m3u8) work best.</span>
                </div>
              </div>
            )}

            {!loading && hasResults && result.meta && (
              <ResultSummaryCard
                meta={result.meta}
                sourceCount={result.sources.length}
                tookMs={result.took}
                finalUrl={result.finalUrl}
                bestSource={bestSource}
                onWatchBest={bestSource ? () => openWatch(bestSource) : undefined}
                onDownloadBest={bestDownloadSource && settings.downloadMode === "progress" ? () => openDownload(bestDownloadSource) : undefined}
              />
            )}

            {/* Results toolbar with filter pills */}
            {!loading && hasResults && (
              <ResultsToolbar
                sources={displaySources}
                host={result.meta?.host}
                onClear={reset}
                qualitySort={qualitySort}
                onQualitySort={setQualitySort}
                onExportJSON={() => exportResults("json")}
                onExportCSV={() => exportResults("csv")}
              >
                {(filtered) => (
                  <div className="space-y-2.5">
                    {filtered.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border bg-card/30 px-4 py-6 text-center text-xs text-muted-foreground">
                        No sources match this filter.
                      </p>
                    ) : (
                      filtered.map((s, i) => (
                        <SourceCard
                          key={s.url + i}
                          source={s}
                          index={i}
                          onWatch={() => openWatch(s)}
                          onDownloadProgress={
                            settings.downloadMode === "progress"
                              ? () => openDownload(s)
                              : undefined
                          }
                          poster={poster}
                          isBest={
                            settings.showBestBadge &&
                            s.url === bestUrl &&
                            result.sources.length > 1
                          }
                          isFavorite={favorites.has(s.pageUrl || s.url)}
                          onToggleFavorite={() => toggleFavorite(s.pageUrl || s.url)}
                          cardIdx={i}
                        />
                      ))
                    )}
                  </div>
                )}
              </ResultsToolbar>
            )}

            {!loading && hasResults && result.meta?.title && (
              <p className="mt-4 truncate px-1 text-xs text-muted-foreground/80">
                {result.meta.title}
              </p>
            )}
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/60 bg-background/95 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <button
            onClick={() => setAboutOpen(true)}
            className="group flex items-center gap-2 btn-press"
            aria-label="About Reel"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-sm transition-shadow group-hover:shadow-md">
              <Clapperboard className="h-3 w-3" />
            </span>
            <span className="text-xs font-bold text-foreground">Reel</span>
          </button>
          <div className="flex items-center gap-2">
            {stats && stats.totalFetches > 0 && (
              <StatsBadge
                totalFetches={stats.totalFetches}
                totalSources={stats.totalSources}
                uniqueHosts={stats.uniqueHosts}
                variant="footer"
              />
            )}
            <span className="text-[10px] font-medium text-muted-foreground">v2.3</span>
          </div>
        </div>
      </footer>

      <WatchDialog
        source={watch}
        open={watchOpen}
        onOpenChange={setWatchOpen}
        title={result?.meta?.title || watch?.quality}
        poster={result?.meta?.thumbnail}
        onDownloadProgress={
          watch ? () => {
            setWatchOpen(false);
            setTimeout(() => {
              setDownload(watch);
              setDownloadOpen(true);
            }, 150);
          } : undefined
        }
      />

      <DownloadProgressDialog
        source={download}
        open={downloadOpen}
        onOpenChange={setDownloadOpen}
      />

      <InsightsDialog open={insightsOpen} onOpenChange={setInsightsOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} version="2.3" />
    </div>
  );
}
