"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Clapperboard,
  Clock,
  Lock,
  Globe,
  Code2,
  Heart,
  ExternalLink,
  Layers,
  FileVideo,
  MonitorPlay,
  Film,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version?: string;
}

const FEATURES = [
  { icon: Clock, label: "Fast extraction", desc: "Cloudflare-aware curl backend scans pages in seconds" },
  { icon: Lock, label: "Secure proxy", desc: "All downloads proxied through server - no direct exposure" },
  { icon: Layers, label: "Multi-format", desc: "HLS, DASH, MP4, TS, WEBM - detects and classifies automatically" },
  { icon: FileVideo, label: "Inline preview", desc: "Watch any source directly in the browser with HLS.js support" },
  { icon: MonitorPlay, label: "Site extractors", desc: "10+ specialized parsers for popular video hosting platforms" },
  { icon: Film, label: "Batch mode", desc: "Paste multiple URLs and fetch all sources in parallel" },
];

export function AboutDialog({ open, onOpenChange, version = "2.3" }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0 sm:rounded-xl">
        {/* Header with gradient accent */}
        <div className="relative overflow-hidden border-b border-border">
          <div aria-hidden className="h-1 bg-gradient-to-r from-primary/0 via-primary/60 to-primary/0" />
          <DialogHeader className="px-5 pt-5 pb-4">
            <DialogTitle className="flex items-center gap-2.5 text-base">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-md shadow-primary/25">
                <Clapperboard className="h-4 w-4" />
              </span>
              Reel
              <Badge variant="secondary" className="ml-1 px-2 py-0 text-[10px] font-bold tabular-nums">
                v{version}
              </Badge>
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs leading-relaxed">
              A personal video source extraction tool. Paste a page or stream URL, fetch all playable video sources, watch inline, or download with progress tracking.
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Feature grid */}
        <div className="scroll-thin max-h-[60vh] overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <div
                key={f.label}
                className="group flex items-start gap-2.5 rounded-lg border border-border/50 bg-card/40 p-3 transition-colors hover:border-primary/30 hover:bg-card/60"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/15 transition-transform group-hover:scale-110">
                  <f.icon className="h-3 w-3" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">{f.label}</p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Tech stack */}
          <div className="mt-4 rounded-lg border border-border/50 bg-muted/30 p-3">
            <p className="text-[10px] font-bold text-muted-foreground/70">
              Built with
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {["Next.js 16", "TypeScript", "Prisma", "Tailwind CSS 4", "shadcn/ui", "HLS.js", "recharts"].map((t) => (
                <Badge
                  key={t}
                  variant="outline"
                  className="px-1.5 py-0 text-[9px] font-medium"
                >
                  {t}
                </Badge>
              ))}
            </div>
          </div>

          {/* Ethics notice */}
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/50 bg-primary/5 p-3">
            <Heart className="h-3.5 w-3.5 text-primary/60 shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              For personal use only. Respect copyright, terms of service, and content creators&apos; rights. Do not redistribute extracted content.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground/60">
              Open-source video source extraction tool
            </p>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
                <Globe className="h-2.5 w-2.5" />
                Works offline (PWA)
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
                <Code2 className="h-2.5 w-2.5" />
                <a
                  href="https://github.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
                >
                  Source
                  <ExternalLink className="h-2 w-2" />
                </a>
              </span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
