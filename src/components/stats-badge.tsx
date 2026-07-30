"use client";

import { BarChart3 } from "lucide-react";
import { useCountUp } from "@/hooks/use-count-up";

interface StatsBadgeProps {
  totalFetches: number;
  totalSources: number;
  uniqueHosts: number;
  variant?: "hero" | "footer";
}

/**
 * StatsBadge - renders the usage stats pill with an animated count-up.
 *
 * - `hero` variant: full 3-stat display, larger, animated.
 * - `footer` variant: compact single-stat, no animation (footer is subtle).
 */
export function StatsBadge({
  totalFetches,
  totalSources,
  uniqueHosts,
  variant = "hero",
}: StatsBadgeProps) {
  const animFetches = useCountUp(totalFetches, 1000);
  const animSources = useCountUp(totalSources, 1100);
  const animHosts = useCountUp(uniqueHosts, 1200);

  if (variant === "footer") {
    return (
      <span className="flex items-center gap-1 rounded-full border border-border/40 bg-card/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground/70">
        <BarChart3 className="h-2.5 w-2.5 text-primary/50" />
        {totalFetches.toLocaleString()} fetches
      </span>
    );
  }

  return (
    <div className="animate-scale-in mt-5 flex items-center justify-center gap-2.5 rounded-full border border-border/60 bg-card/50 px-4 py-1.5 shadow-sm backdrop-blur-sm">
      <BarChart3 className="h-3.5 w-3.5 text-primary/60" />
      <div className="flex items-center gap-2.5 text-[11px] font-medium">
        <Stat value={animFetches} label="fetches" />
        <Sep />
        <Stat value={animSources} label="sources" />
        <Sep />
        <Stat value={animHosts} label="hosts" />
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="tabular-nums text-foreground">{value.toLocaleString()}</span>
      <span className="text-muted-foreground/70">{label}</span>
    </span>
  );
}

function Sep() {
  return <span className="text-muted-foreground/30">·</span>;
}
