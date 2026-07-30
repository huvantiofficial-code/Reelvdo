"use client";

import { useState } from "react";
import {
  Download,
  Play,
  Copy,
  Check,
  ExternalLink,
  Film,
  Layers,
  FileVideo,
  MonitorPlay,
  Globe,
  Star,
  StarOff,
  Code2,
  ShieldAlert,
  Eye,
} from "lucide-react";
import type { MediaType, VideoSource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<MediaType, string> = {
  mp4: "MP4",
  m3u8: "HLS",
  mpd: "DASH",
  ts: "TS",
  webm: "WEBM",
  mov: "MOV",
  mkv: "MKV",
  image: "IMG",
  iframe: "EMBED",
  audio: "AUDIO",
  unknown: "FILE",
};

const TYPE_ACCENT: Partial<Record<MediaType, string>> = {
  m3u8: "from-sky-500/85 to-sky-600/95",
  mpd: "from-violet-500/85 to-violet-600/95",
  mp4: "from-emerald-500/85 to-emerald-600/95",
  webm: "from-amber-500/85 to-amber-600/95",
  ts: "from-rose-500/85 to-rose-600/95",
  mov: "from-cyan-500/85 to-cyan-600/95",
  mkv: "from-orange-500/85 to-orange-600/95",
};

const TYPE_ICON_COLOR: Partial<Record<MediaType, string>> = {
  m3u8: "text-sky-600 dark:text-sky-400",
  mpd: "text-violet-600 dark:text-violet-400",
  mp4: "text-emerald-600 dark:text-emerald-400",
  webm: "text-amber-600 dark:text-amber-400",
  ts: "text-rose-600 dark:text-rose-400",
  mov: "text-cyan-600 dark:text-cyan-400",
  mkv: "text-orange-600 dark:text-orange-400",
};

function TypeIcon({ type, className }: { type: MediaType; className?: string }) {
  if (type === "m3u8") return <Layers className={className} />;
  if (type === "mpd") return <Layers className={className} />;
  if (type === "mp4" || type === "webm" || type === "mov" || type === "mkv")
    return <FileVideo className={className} />;
  if (type === "ts") return <Film className={className} />;
  return <MonitorPlay className={className} />;
}

export function downloadUrlFor(src: VideoSource): string {
  const pageParam = src.pageUrl ? `&page=${encodeURIComponent(src.pageUrl)}` : "";

  // Prefer the original filename (e.g. streamtape's slug from /v/{id}/{slug.mp4}).
  // This preserves the user-visible "original file" name on download instead of
  // a generic label like "mp4.mp4".
  let originalName: string | undefined;
  if (src.filename) {
    // Sanitize but keep the original extension / unicode chars where possible.
    const cleaned = src.filename.replace(/[\\/:*?"<>|]/g, "_").trim();
    if (cleaned) originalName = cleaned;
  }

  if (src.type === "m3u8" || src.type === "mpd") {
    const fallback = (src.label || src.quality || "video")
      .toString()
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
    const name = originalName || fallback || "video";
    return `/api/stream?url=${encodeURIComponent(src.url)}&name=${encodeURIComponent(name)}${pageParam}`;
  }

  const ext = src.ext || "mp4";
  if (originalName) {
    // If the original filename already has an extension, use it as-is.
    // Otherwise, append the detected extension.
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(originalName);
    const name = hasExt ? originalName : `${originalName}.${ext}`;
    return `/api/proxy?url=${encodeURIComponent(src.url)}&download=1&name=${encodeURIComponent(name)}${pageParam}`;
  }

  const baseName = (src.label || src.quality || "video")
    .toString()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `/api/proxy?url=${encodeURIComponent(src.url)}&download=1&name=${baseName || "video"}.${ext}${pageParam}`;
}

/** Generate an HTML embed snippet for the source. */
export function embedCodeFor(src: VideoSource): string {
  const url = src.url;
  if (src.type === "m3u8" || src.type === "mpd") {
    // Use hls.js via CDN for HLS/DASH playback in embed
    return `<!-- HLS/DASH embed — requires hls.js -->
<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;">
  <video id="reel-${Date.now().toString(36)}" controls playsinline
    style="position:absolute;top:0;left:0;width:100%;height:100%;background:#000;"></video>
</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<script>
  (function(){
    var v=document.currentScript.previousElementSibling.querySelector('video');
    var s="${url}";
    if(v.canPlayType('application/vnd.apple.mpegurl')){v.src=s;}
    else if(window.Hls&&Hls.isSupported()){var h=new Hls();h.loadSource(s);h.attachMedia(v);}
    else{v.textContent='HLS not supported';}
  })();
</script>`;
  }
  // MP4 / direct video
  return `<video src="${url}" controls playsinline preload="metadata"
  style="width:100%;max-width:1280px;border-radius:8px;background:#000;"></video>`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

interface SourceCardProps {
  source: VideoSource;
  index: number;
  onWatch: () => void;
  onDownloadProgress?: () => void;
  poster?: string;
  isBest?: boolean;
  showKeyHint?: boolean;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  /** Card index for stagger animation. */
  cardIdx?: number;
  /** When true (e.g. Alt key held), show large number overlay on cards 1-9 */
  showNumberOverlay?: boolean;
}

export function SourceCard({ source, index, onWatch, onDownloadProgress, poster, isBest, showKeyHint = true, isFavorite, onToggleFavorite, cardIdx = 0, showNumberOverlay = false }: SourceCardProps) {
  const [copied, setCopied] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const [hovered, setHovered] = useState(false);
  const host = hostOf(source.url);
  const accent = TYPE_ACCENT[source.type] || "from-primary/85 to-primary/95";
  const iconColor = TYPE_ICON_COLOR[source.type] || "text-primary";
  // iframe sources are pages that require interactive captcha (e.g.
  // playmogo.com DoodStream clones). We can't preview/download them
  // server-side — the user must open the page in a new tab.
  const isIframe = source.type === "iframe";
  // Embeddable iframes are meant to be played inline in the watch dialog
  // via `<iframe src="...">` (e.g. YouTube /embed/{id}, FB /plugins/video.php,
  // Instagram /reel/{id}/embed/, Telegram ?embed=1, VK video_ext.php,
  // Twitter platform.twitter.com/embed). These get a "Watch" button.
  // Non-embeddable iframes are captcha-protected pages that the user must
  // open in a new tab — they get an "Open page" button only.
  const isEmbeddable = isIframe && source.embeddable === true;
  const isCaptchaIframe = isIframe && !isEmbeddable;
  // For iframe sources, the label/quality tells us which page this is
  // (watch vs download). Use it to pick the right button label.
  const isWatchPage = isIframe && (source.quality === "Watch" || /watch/i.test(source.label || ""));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  const copyEmbed = async () => {
    try {
      await navigator.clipboard.writeText(embedCodeFor(source));
      setEmbedCopied(true);
      setTimeout(() => setEmbedCopied(false), 1600);
    } catch {}
  };

  return (
    <div
      style={{ "--card-idx": cardIdx } as React.CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "group relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border/60 bg-card/70 p-3.5 transition-all duration-200 backdrop-blur-sm",
        "card-hover hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10",
        "sm:flex-row sm:items-center sm:justify-between",
        isBest && "gradient-border border-primary/40 ring-1 ring-primary/20 animate-best-pulse",
        "animate-card-in ripple-effect"
      )}
    >
      {/* Decorative left accent line */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 top-0 h-full w-0.5 bg-primary/0 transition-colors duration-300",
          hovered ? "bg-primary/50" : "",
          isBest && "bg-primary/70"
        )}
      />

      {/* Hover glow overlay */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-primary/0 to-primary/0 transition-all duration-300",
          hovered && !isBest && "from-primary/3 to-primary/1",
          isBest && "from-primary/5 to-primary/2"
        )}
      />

      <div className="flex min-w-0 items-center gap-3">
        {/* Thumbnail / icon — 16:9 aspect, larger */}
        <div className="relative flex h-16 w-[5.5rem] shrink-0 items-center justify-center overflow-hidden rounded-lg shadow-sm ring-1 ring-border/40 sm:h-14 sm:w-20">
          {poster && imgOk ? (
            <img
              src={poster}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
              onError={() => setImgOk(false)}
            />
          ) : (
            <div className="thumb-gradient thumb-scanlines relative flex h-full w-full items-center justify-center">
              <TypeIcon type={source.type} className={cn("h-5 w-5 transition-transform duration-300 group-hover:scale-110", iconColor)} />
              {/* Subtle play triangle accent in corner */}
              <span aria-hidden className="absolute bottom-1 right-1 opacity-40">
                <Play className={cn("h-2.5 w-2.5", iconColor)} />
              </span>
            </div>
          )}
          {/* Bottom gradient overlay */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/40 to-transparent"
          />
          {/* Type badge — gradient pill with shadow */}
          <span
            className={cn(
              "absolute bottom-1 left-1 rounded-md bg-gradient-to-br px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.04em] text-white shadow-md backdrop-blur-sm",
              accent
            )}
          >
            {TYPE_LABEL[source.type]}
          </span>
          {isBest && (
            <span className="absolute right-1 top-1 rounded-md bg-gradient-to-br from-primary to-primary/80 px-2 py-0.5 text-[8px] font-bold uppercase tracking-[0.04em] text-primary-foreground shadow-md shadow-primary/30 animate-bounce-gentle">
              Best
            </span>
          )}
          {/* Keyboard number overlay — shown when Alt held */}
          {showNumberOverlay && index < 9 && (
            <span className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-scale-in">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-base font-bold text-primary-foreground shadow-lg shadow-primary/40 ring-2 ring-primary-foreground/30">
                {index + 1}
              </span>
            </span>
          )}
        </div>

        {/* Info */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-bold text-foreground">
              {source.quality || TYPE_LABEL[source.type]}
            </span>
            {source.label && source.label !== source.quality && (
              <span className="text-[11px] font-medium text-muted-foreground">
                · {source.label}
              </span>
            )}
            {source.size && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                {source.size}
              </span>
            )}
            {source.ext && (
              <span className="text-[10px] font-bold uppercase text-muted-foreground/80">
                .{source.ext}
              </span>
            )}
            {isCaptchaIframe && (
              <span className="inline-flex items-center gap-0.5 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                <ShieldAlert className="h-2.5 w-2.5" />
                Captcha
              </span>
            )}
            {isEmbeddable && (
              <span className="inline-flex items-center gap-0.5 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                <Play className="h-2.5 w-2.5" />
                Embed
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{host}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="shrink-0 rounded-sm bg-muted px-1 tabular-nums text-[10px] font-bold">#{index + 1}</span>
            {index < 9 && showKeyHint && (
              <kbd
                className="hidden shrink-0 rounded border border-border bg-muted px-1 py-px font-mono text-[9px] font-bold text-foreground/70 shadow-sm sm:inline"
                title={`Press ${index + 1} to open`}
              >
                {index + 1}
              </kbd>
            )}
          </div>
          {isCaptchaIframe && (
            <div className="mt-1.5 text-[10px] leading-tight text-amber-600 dark:text-amber-400/90">
              Site requires interactive captcha. Open in a new tab to watch or download.
            </div>
          )}
          {isEmbeddable && (
            <div className="mt-1.5 text-[10px] leading-tight text-emerald-600 dark:text-emerald-400/90">
              Official embed player — plays inline in the watch dialog.
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        {isCaptchaIframe ? (
          // For captcha-protected iframe pages, render a single
          // prominent "Open page" button that opens the URL in a new tab.
          // No Watch/Download buttons — those would fail because the URL is
          // an HTML page, not a media file.
          <Button
            size="sm"
            variant="default"
            asChild
            className="gap-1.5 btn-press shadow-sm"
          >
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              title={isWatchPage ? "Open watch page in a new tab" : "Open download page in a new tab"}
            >
              {isWatchPage ? <Eye className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{isWatchPage ? "Open watch" : "Open download"}</span>
              <span className="sm:hidden">{isWatchPage ? "Watch" : "Download"}</span>
            </a>
          </Button>
        ) : isEmbeddable ? (
          // For embeddable iframe sources (YouTube embed, FB plugin, IG embed,
          // Telegram embed, VK video_ext, Twitter embed), render a "Watch"
          // button that opens the watch dialog with an inline `<iframe>`,
          // plus an "Open" button to open the embed URL in a new tab.
          <>
            <Button
              size="sm"
              variant="default"
              onClick={onWatch}
              className="gap-1.5 btn-press shadow-sm"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span className="hidden sm:inline">Watch</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              asChild
              className="gap-1.5 btn-press px-2 sm:px-3"
            >
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open embed in new tab"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Open</span>
              </a>
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="default"
              onClick={onWatch}
              className="gap-1.5 btn-press shadow-sm"
            >
              <Play className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Watch</span>
            </Button>
            {onDownloadProgress ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onDownloadProgress}
                className="gap-1.5 btn-press px-2 sm:px-3"
                title="Download with progress"
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Download</span>
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                asChild
                className="gap-1.5 px-2 sm:px-3"
              >
                <a href={downloadUrlFor(source)} download>
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Download</span>
                </a>
              </Button>
            )}
          </>
        )}
        {/* Divider */}
        <span aria-hidden className="mx-0.5 h-6 w-px bg-border/70 hidden sm:block" />
        {/* Favorite toggle */}
        {onToggleFavorite && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onToggleFavorite}
                  aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                  className={cn("hidden h-8 w-8 px-0 btn-press sm:inline-flex", isFavorite ? "text-primary" : "text-muted-foreground hover:text-primary")}
                >
                  {isFavorite ? (
                    <Star className="h-3.5 w-3.5 fill-primary" />
                  ) : (
                    <StarOff className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{isFavorite ? "In favorites" : "Add to favorites"}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {/* Copy embed code — hidden for iframe sources (not embeddable) */}
        {!isCaptchaIframe && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={copyEmbed}
                  aria-label="Copy embed code"
                  className="hidden h-8 w-8 px-0 text-muted-foreground hover:text-foreground btn-press sm:inline-flex"
                >
                  {embedCopied ? (
                    <Check className="h-3.5 w-3.5 text-primary animate-check-pop" />
                  ) : (
                    <Code2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{embedCopied ? "Embed copied!" : "Copy embed code"}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                asChild
                aria-label="Open source in new tab"
                className="hidden h-8 w-8 px-0 text-muted-foreground hover:text-foreground btn-press sm:inline-flex"
              >
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Open source in new tab</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                onClick={copy}
                aria-label="Copy link"
                className="h-8 w-8 px-0 text-muted-foreground hover:text-foreground btn-press"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-primary animate-check-pop" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{copied ? "Copied!" : "Copy link"}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

export function SourceCardSkeleton() {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <div className="h-14 w-20 shrink-0 rounded-lg animate-skeleton sm:h-12 sm:w-16" />
        <div className="space-y-2">
          <div className="h-3.5 w-24 rounded-sm animate-skeleton" />
          <div className="h-3 w-32 rounded-sm animate-skeleton" />
        </div>
      </div>
      <div className="h-8 w-36 rounded-md animate-skeleton" />
    </div>
  );
}

export { cn };
