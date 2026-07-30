"use client";

import { useMemo, useState } from "react";
import { Filter, Copy, Check, X, Layers, ArrowDownAz, ArrowUpAz, FileJson, FileSpreadsheet, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MediaType, VideoSource } from "@/lib/types";
import { toast } from "sonner";

interface ResultsToolbarProps {
  sources: VideoSource[];
  host?: string;
  onClear: () => void;
  /** Quality sort mode. */
  qualitySort?: "none" | "desc" | "asc";
  /** Callback when quality sort changes. */
  onQualitySort?: (mode: "none" | "desc" | "asc") => void;
  /** Export as JSON. */
  onExportJSON?: () => void;
  /** Export as CSV. */
  onExportCSV?: () => void;
  /** Children are the filtered source cards. */
  children: (filtered: VideoSource[]) => React.ReactNode;
}

type FilterType = "all" | MediaType;

const FILTER_LABELS: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mp4", label: "MP4" },
  { key: "m3u8", label: "HLS" },
  { key: "mpd", label: "DASH" },
  { key: "ts", label: "TS" },
  { key: "webm", label: "WEBM" },
];

export function ResultsToolbar({ sources, host, onClear, qualitySort, onQualitySort, onExportJSON, onExportCSV, children }: ResultsToolbarProps) {
  const [active, setActive] = useState<FilterType>("all");
  const [copiedAll, setCopiedAll] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const counts = useMemo(() => {
    const m = new Map<FilterType, number>();
    m.set("all", sources.length);
    for (const s of sources) m.set(s.type, (m.get(s.type) || 0) + 1);
    return m;
  }, [sources]);

  const available = useMemo(
    () => FILTER_LABELS.filter((f) => f.key === "all" || (counts.get(f.key) || 0) > 0),
    [counts]
  );

  const filtered = useMemo(
    () => (active === "all" ? sources : sources.filter((s) => s.type === active)),
    [active, sources]
  );

  const copyAll = async () => {
    try {
      const text = sources.map((s) => s.url).join("\n");
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      toast.success(`Copied ${sources.length} link${sources.length === 1 ? "" : "s"}`);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch {
      toast.error("Clipboard access blocked by browser");
    }
  };

  return (
    <div className="space-y-3">
      {/* Toolbar row */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2.5 backdrop-blur-sm shadow-sm">
        <div className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <Layers className="h-3.5 w-3.5 text-primary" />
            {sources.length} source{sources.length === 1 ? "" : "s"}
          </span>
          {host && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground">{host}</span>
            </>
          )}
          {/* Quality sort toggle */}
          {onQualitySort && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const next = qualitySort === "none" ? "desc" : qualitySort === "desc" ? "asc" : "none";
                      onQualitySort(next);
                    }}
                    className={cn(
                      "h-7 gap-1 px-2 text-xs btn-press",
                      qualitySort !== "none" ? "text-primary" : "text-muted-foreground"
                    )}
                  >
                    {qualitySort === "desc" ? (
                      <ArrowDownAz className="h-3.5 w-3.5" />
                    ) : qualitySort === "asc" ? (
                      <ArrowUpAz className="h-3.5 w-3.5" />
                    ) : (
                      <ArrowDownAz className="h-3.5 w-3.5 opacity-40" />
                    )}
                    <span className="hidden sm:inline">
                      {qualitySort === "none" ? "Sort" : qualitySort === "desc" ? "Best first" : "Worst first"}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Sort by quality</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Export dropdown */}
          {(onExportJSON || onExportCSV) && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    className="h-7 gap-1.5 px-2 text-xs text-muted-foreground btn-press"
                    aria-label="Export results"
                  >
                    <Download className="h-3 w-3" />
                    <span className="hidden sm:inline">Export</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Export results</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {showExportMenu && (
            <div className="animate-scale-in absolute right-4 top-12 z-50 flex flex-col rounded-lg border border-border bg-card p-1 shadow-lg">
              {onExportJSON && (
                <button
                  type="button"
                  onClick={() => { onExportJSON(); setShowExportMenu(false); }}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                >
                  <FileJson className="h-3.5 w-3.5 text-primary/70" />
                  Export as JSON
                </button>
              )}
              {onExportCSV && (
                <button
                  type="button"
                  onClick={() => { onExportCSV(); setShowExportMenu(false); }}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-primary/70" />
                  Export as CSV
                </button>
              )}
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={copyAll}
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground btn-press"
            aria-label="Copy all links"
          >
            {copiedAll ? (
              <Check className="h-3 w-3 text-primary" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            Copy all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onClear}
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground btn-press"
          >
            <X className="h-3 w-3" />
            Clear
          </Button>
        </div>
      </div>

      {/* Filter pills */}
      {available.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          <span className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground/70">
            <Filter className="h-3 w-3" />
            Filter
          </span>
          {available.map((f) => {
            const n = counts.get(f.key) || 0;
            const isActive = active === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setActive(f.key)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all duration-200 btn-press",
                  isActive
                    ? "border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                    : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
                )}
                aria-pressed={isActive}
              >
                {f.label}
                <span
                  className={cn(
                    "ml-1.5 tabular-nums",
                    isActive ? "text-primary-foreground/80" : "text-muted-foreground/60"
                  )}
                >
                  {n}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {children(filtered)}
    </div>
  );
}
