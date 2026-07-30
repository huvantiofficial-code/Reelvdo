"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { VideoPlayer } from "@/components/video-player";
import { Download, ExternalLink, Copy, Check, Globe, Clock, Star, StarOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { downloadUrlFor } from "@/components/source-card";
import type { VideoSource } from "@/lib/types";
import { useState } from "react";
import { toast } from "sonner";

interface WatchDialogProps {
  source: VideoSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  poster?: string;
  onDownloadProgress?: () => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

export function WatchDialog({ source, open, onOpenChange, title, poster, onDownloadProgress }: WatchDialogProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!source) return null;

  const host = hostOf(source.url);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(source.url);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Could not copy link");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0 sm:rounded-xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm font-semibold">
                {title || source.quality || "Preview"}
              </DialogTitle>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Globe className="h-3 w-3" />
                  {host}
                </span>
                <span className="text-muted-foreground/40">·</span>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-semibold uppercase">
                  {source.type}
                </Badge>
                {source.quality && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
                    {source.quality}
                  </Badge>
                )}
                {source.size && (
                  <span className="rounded-md bg-muted px-1 py-0 text-[10px] text-muted-foreground/70">{source.size}</span>
                )}
                {source.ext && (
                  <span className="text-[10px] uppercase text-muted-foreground/60">.{source.ext}</span>
                )}
              </div>
            </div>
          </div>
          <DialogDescription className="sr-only">
            Video preview player with download option
          </DialogDescription>
        </DialogHeader>

        <div className="bg-black">
          <VideoPlayer
            url={source.url}
            type={source.type}
            poster={poster}
            title={title || source.quality}
            pageUrl={source.pageUrl}
            embeddable={source.embeddable}
          />
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-card/80 px-4 py-3 backdrop-blur-sm">
          {onDownloadProgress ? (
            <Button size="sm" className="gap-1.5 btn-press" onClick={onDownloadProgress}>
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Download with progress</span>
              <span className="sm:hidden">Download</span>
            </Button>
          ) : (
            <Button asChild size="sm" className="gap-1.5 btn-press">
              <a href={downloadUrlFor(source)} download>
                <Download className="h-3.5 w-3.5" />
                Download
              </a>
            </Button>
          )}
          <Button
            asChild
            size="sm"
            variant="outline"
            className="gap-1.5 btn-press"
          >
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Open source</span>
              <span className="sm:hidden">Open</span>
            </a>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={copyLink}
            className="gap-1.5 text-muted-foreground btn-press"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 animate-check-pop text-primary" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">{copied ? "Copied!" : "Copy link"}</span>
          </Button>
          <button
            type="button"
            onClick={() => setShowRaw((s) => !s)}
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground btn-press"
          >
            <Clock className="h-3 w-3" />
            {showRaw ? "Hide link" : "Show link"}
          </button>
        </div>
        {showRaw && (
          <div className="animate-fade-up border-t border-border bg-muted/30 px-4 py-3 backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <Globe className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              <p className="truncate break-all font-mono text-[11px] text-muted-foreground leading-relaxed">
                {source.url}
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
