"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Clapperboard, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version?: string;
}

const HIGHLIGHTS = [
  "Multi-format: HLS, DASH, MP4, TS",
  "Inline preview with HLS.js",
  "10+ site extractors",
  "Batch fetch & progress tracking",
];

export function AboutDialog({ open, onOpenChange, version = "2.3" }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg sm:max-h-[90vh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:w-full sm:rounded-xl">
        <DialogHeader className="border-b border-border pr-10 px-5 py-4">
          <DialogTitle className="flex items-center gap-2.5 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Clapperboard className="h-4 w-4" />
            </span>
            Reel
            <Badge variant="secondary" className="px-2 py-0 text-[10px] font-semibold tabular-nums">
              v{version}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
          <p className="text-xs text-muted-foreground">
            Video source extraction tool. Paste a URL, fetch sources, watch or download.
          </p>

          <ul className="mt-3 space-y-1.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h} className="flex items-start gap-2 text-xs text-foreground/80">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary" aria-hidden />
                {h}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3 pr-10">
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
            <Globe className="h-2.5 w-2.5" />
            PWA · offline ready
          </span>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            Source
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
