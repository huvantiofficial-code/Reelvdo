"use client";

import { useState } from "react";
import {
  Play,
  Download,
  Globe,
  Clock,
  FileVideo,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ExtractMeta, VideoSource } from "@/lib/types";
import { downloadUrlFor } from "@/components/source-card";

// --- Known site extractors ---
// Maps host substrings to a short display label for the extraction method badge.
const KNOWN_SITES: { match: string[]; label: string }[] = [
  { match: ["luluvdo", "lulustream", "luluvid"], label: "lulustream" },
  { match: ["firestream"], label: "firestream" },
  { match: ["playmate"], label: "playmate" },
  { match: ["vidara", "odysseusa"], label: "vidara" },
  { match: ["mixdrop", "miiiixdrop", "mixdroop", "mixdroup"], label: "mixdrop" },
  { match: ["streamtape", "tpead", "stape.", "stpe.net", "streamta.pe", "tapeplayers", "shavetape", "tapetv", "tapeonline"], label: "streamtape" },
  { match: ["doodstream", "dood.so", "dood.yt", "dood."], label: "doodstream" },
  {
    match: ["streamwish", "swhoi", "filelions", "filelion", "embedwish", "awish",
            "mhdflix", "vidplay", "supervideo", "streamhub", "megacloud",
            "kalelmeh", "moviehab", "vidgomax", "player.akamai", "yzzzz",
            "streamcloud", "streamhg"],
    label: "streamwish",
  },
  { match: ["filemoon", "moonq"], label: "filemoon" },
  { match: ["erome"], label: "erome" },
  { match: ["xhamster"], label: "xhamster" },
  { match: ["xvideos", "xnxx"], label: "xvideos/xnxx" },
  { match: ["pornhub"], label: "pornhub" },
  { match: ["redtube"], label: "redtube" },
  { match: ["youporn"], label: "youporn" },
  { match: ["eporner"], label: "eporner" },
  { match: ["drtuber"], label: "drtuber" },
  { match: ["xozilla"], label: "xozilla" },
  { match: ["porndr"], label: "porndr" },
  { match: ["ukdevilz"], label: "ukdevilz" },
  { match: ["vids.st"], label: "vids.st" },
  { match: ["spankbang"], label: "spankbang" },
  { match: ["txxx", "hdzog", "upornia", "tubepornclassic", "voyeurhit", "momvids", "shemalez"], label: "txxx-network" },
  { match: ["voe.sx", "voeunblk", "voeunblock", "voe-unblock"], label: "voe" },
  { match: ["upstream.to", "upstream"], label: "upstream" },
  { match: ["send.cm", "send.now"], label: "send" },
  { match: ["vidmoly"], label: "vidmoly" },
  { match: ["streamsb", "streamlare", "sbface", "sbplay"], label: "streamsb" },
  { match: ["krakenfiles", "krakencloud"], label: "krakenfiles" },
  { match: ["upfiles", "upfilesgo"], label: "upfiles" },
  { match: ["morencius", "vidhide", "vidhidepro", "vidhidelink", "vidhidecity", "vidshide", "vidshost", "mexash", "fileabc", "tachist", "mosevura", "dramiyos", "earnvids", "minochinos", "playmogo", "indobaliu", "boodstream", "vidoo"], label: "morencius" },
  { match: ["youtube.com", "youtu.be", "youtube-nocookie"], label: "youtube" },
  { match: ["facebook.com", "fb.watch", "fb.com"], label: "facebook" },
  { match: ["instagram.com", "instagr.am"], label: "instagram" },
  { match: ["t.me", "telegram.me", "telegram.org"], label: "telegram" },
  { match: ["vk.com", "vkontakte.ru", "userapi.com"], label: "vk" },
  { match: ["x.com", "twitter.com", "twimg.com"], label: "x-twitter" },
  { match: ["threads.net", "threads.com"], label: "threads" },
];

function getSiteExtractorName(host: string): string | null {
  if (!host) return null;
  const lower = host.toLowerCase();
  for (const site of KNOWN_SITES) {
    if (site.match.some((m) => lower.includes(m))) {
      return site.label;
    }
  }
  return null;
}

function faviconUrl(host: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
}

// --- Props ---

interface ResultSummaryCardProps {
  meta: ExtractMeta;
  sourceCount: number;
  tookMs?: number;
  finalUrl?: string;
  bestSource?: VideoSource;
  onWatchBest?: () => void;
  onDownloadBest?: () => void;
}

export function ResultSummaryCard({
  meta,
  sourceCount,
  tookMs,
  finalUrl,
  bestSource,
  onWatchBest,
  onDownloadBest,
}: ResultSummaryCardProps) {
  const [imgOk, setImgOk] = useState(true);
  const [faviconOk, setFaviconOk] = useState(true);

  const host = meta.host || (finalUrl ? hostOf(finalUrl) : undefined);
  const siteName = host ? getSiteExtractorName(host) : null;
  const isSiteExtractor = siteName !== null;

  const tookSec =
    tookMs != null ? (tookMs < 1000 ? `${tookMs}ms` : `${(tookMs / 1000).toFixed(1)}s`) : undefined;

  return (
    <div
      className={cn(
        "animate-fade-up group relative overflow-hidden rounded-xl border border-border/70 bg-card/80 shadow-md shadow-black/[0.04] backdrop-blur-sm transition-all duration-200",
        "hover:shadow-lg hover:shadow-primary/5 hover:border-primary/30",
        "dark:bg-card/60 dark:shadow-black/20"
      )}
    >
      {/* Top accent strip */}
      <div aria-hidden className="h-0.5 bg-gradient-to-r from-primary/0 via-primary/60 to-primary/0" />
      <div className="flex flex-col sm:flex-row gap-4 p-4 sm:p-5">
        {/* --- Thumbnail --- */}
        <div
          className={cn(
            "relative flex items-center justify-center overflow-hidden rounded-lg shrink-0",
            "w-full sm:w-40 aspect-video sm:aspect-[16/9] sm:h-auto",
            "bg-muted ring-1 ring-border/40 shadow-sm"
          )}
        >
          {meta.thumbnail && imgOk ? (
            <img
              src={meta.thumbnail}
              alt={meta.title || "Page thumbnail"}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              onError={() => setImgOk(false)}
            />
          ) : (
            <div className="thumb-gradient thumb-scanlines flex h-full w-full items-center justify-center text-primary">
              <FileVideo className="h-8 w-8 opacity-70" />
            </div>
          )}
          {/* Bottom gradient overlay */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/40 to-transparent"
          />
          {/* Play icon overlay on hover */}
          <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-300 group-hover:bg-black/20 group-hover:opacity-100">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-lg shadow-primary/40 backdrop-blur-sm">
              <Play className="h-4 w-4 fill-current" />
            </span>
          </span>
        </div>

        {/* --- Content --- */}
        <div className="flex flex-col gap-2 min-w-0 flex-1">
          {/* Title row */}
          {meta.title && (
            <h3 className="text-sm sm:text-base font-bold text-foreground truncate leading-snug">
              {meta.title}
            </h3>
          )}

          {/* Host + favicon row */}
          {host && (
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {faviconOk ? (
                <img
                  src={faviconUrl(host)}
                  alt=""
                  width={14}
                  height={14}
                  className="h-3.5 w-3.5 shrink-0 rounded-sm"
                  onError={() => setFaviconOk(false)}
                />
              ) : (
                <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{host}</span>
              {finalUrl && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={finalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center text-muted-foreground/60 hover:text-primary transition-colors"
                        aria-label="Visit original page"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TooltipTrigger>
                    <TooltipContent>Visit original page</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          )}

          {/* Description (optional) */}
          {meta.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {meta.description}
            </p>
          )}

          {/* --- Metadata line --- */}
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {/* Extraction method badge */}
            {isSiteExtractor ? (
              <Badge
                variant="default"
                className="gap-1 text-[10px] px-2 py-0.5 font-bold animate-scale-in shadow-sm shadow-primary/20"
              >
                Site extractor · {siteName}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="gap-1 text-[10px] px-2 py-0.5 font-semibold animate-scale-in"
              >
                Generic scan
              </Badge>
            )}

            {/* Source count badge */}
            <Badge
              variant="secondary"
              className="gap-1 text-[10px] px-2 py-0.5 font-semibold tabular-nums animate-scale-in"
            >
              <FileVideo className="h-3 w-3" />
              {sourceCount} source{sourceCount !== 1 ? "s" : ""}
            </Badge>

            {/* Time taken */}
            {tookSec && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px] px-2 py-0.5 font-semibold tabular-nums animate-scale-in"
              >
                <Clock className="h-3 w-3" />
                Extracted in {tookSec}
              </Badge>
            )}
          </div>

          {/* --- Action buttons --- */}
          {bestSource && (
            <div className="flex items-center gap-2 mt-2">
              {onWatchBest && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={onWatchBest}
                  className="gap-1.5 btn-press shadow-md shadow-primary/25"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  Watch best
                </Button>
              )}
              {onDownloadBest ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onDownloadBest}
                  className="gap-1.5 btn-press"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Download best</span>
                  <span className="sm:hidden">Download</span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                  className="gap-1.5 btn-press"
                >
                  <a href={downloadUrlFor(bestSource)} download>
                    <Download className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Download best</span>
                    <span className="sm:hidden">Download</span>
                  </a>
                </Button>
              )}
              {bestSource.quality && (
                <span className="text-[11px] font-semibold text-muted-foreground tabular-nums">
                  {bestSource.quality}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
