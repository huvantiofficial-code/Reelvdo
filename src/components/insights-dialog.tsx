"use client";

import { useEffect, useState, useCallback } from "react";
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import { Loader2, BarChart3, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface InsightsHost {
  host: string;
  count: number;
  sources: number;
}
interface InsightsType {
  type: string;
  count: number;
}
interface InsightsQuality {
  quality: string;
  count: number;
}
interface InsightsDay {
  day: string;
  fetches: number;
  sources: number;
}
interface InsightsError {
  host: string;
  error: string;
  createdAt: string;
}
interface InsightsPayload {
  totalFetches: number;
  totalSources: number;
  successRate: number;
  avgTakeMs: number;
  hostsBar: InsightsHost[];
  typeBreakdown: InsightsType[];
  qualityBreakdown: InsightsQuality[];
  timeline: InsightsDay[];
  recentErrors: InsightsError[];
}

interface InsightsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PALETTE = [
  "var(--primary)",
  "color-mix(in oklch, var(--primary) 80%, transparent)",
  "color-mix(in oklch, var(--primary) 60%, transparent)",
  "color-mix(in oklch, var(--primary) 40%, transparent)",
  "color-mix(in oklch, var(--primary) 20%, transparent)",
];

const MAX_ERRORS = 3;

function formatMs(ms: number): string {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const diff = Date.now() - then;
    if (diff < 60_000) return "now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    return `${Math.floor(diff / 86_400_000)}d`;
  } catch {
    return "-";
  }
}

function truncateHost(h: string, max = 22): string {
  if (h.length <= max) return h;
  return h.slice(0, max - 1) + "…";
}

function truncateText(s: string, max = 60): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: unknown }>;
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-popover/95 px-3 py-2 text-xs shadow-md backdrop-blur-sm">
      {label !== undefined && label !== "" && (
        <p className="mb-1 font-medium text-foreground">{String(label)}</p>
      )}
      <ul className="space-y-0.5">
        {payload.map((p, i) => (
          <li key={i} className="flex items-center gap-2 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: p.color || "var(--primary)" }}
              aria-hidden
            />
            <span className="capitalize">{p.name || "value"}</span>
            <span className="ml-auto font-mono font-medium text-foreground">
              {typeof p.value === "number" ? formatNumber(p.value) : p.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function KpiCard({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-card/60 p-3">
      <p className="text-lg font-bold tabular-nums tracking-tight text-foreground sm:text-xl">
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function ChartCard({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border/70 bg-card/40 p-3.5",
        className
      )}
    >
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function InsightsDialog({ open, onOpenChange }: InsightsDialogProps) {
  const [data, setData] = useState<InsightsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/insights", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as InsightsPayload;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  const isEmpty = data && data.totalFetches === 0;
  const recentErrors = (data?.recentErrors ?? []).slice(0, MAX_ERRORS);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl sm:max-h-[90vh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:w-full sm:rounded-xl">
        <DialogHeader className="border-b border-border pr-10 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-primary" />
            Insights
          </DialogTitle>
        </DialogHeader>

        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-xs">Loading…</p>
            </div>
          )}

          {!loading && error && (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-sm font-medium text-foreground">Couldn&apos;t load</p>
              <p className="max-w-xs text-xs text-muted-foreground">{error}</p>
            </div>
          )}

          {!loading && !error && isEmpty && (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No data yet</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Fetch a few URLs to see your activity.
              </p>
            </div>
          )}

          {!loading && !error && data && !isEmpty && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <KpiCard value={formatNumber(data.totalFetches)} label="Fetches" />
                <KpiCard value={formatNumber(data.totalSources)} label="Sources" />
                <KpiCard value={`${data.successRate}%`} label="Success" />
                <KpiCard value={formatMs(data.avgTakeMs)} label="Avg time" />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <ChartCard title="Top hosts" className="lg:col-span-2">
                  {data.hostsBar.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground/70">No hosts yet</p>
                  ) : (
                    <div className="h-[260px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={data.hostsBar}
                          layout="vertical"
                          margin={{ top: 4, right: 28, bottom: 4, left: 8 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--border)"
                            horizontal={false}
                          />
                          <XAxis
                            type="number"
                            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                            stroke="var(--border)"
                            allowDecimals={false}
                          />
                          <YAxis
                            type="category"
                            dataKey="host"
                            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                            stroke="var(--border)"
                            width={110}
                            tickFormatter={truncateHost}
                          />
                          <Tooltip
                            cursor={{ fill: "var(--accent)", opacity: 0.4 }}
                            content={<ChartTooltip />}
                          />
                          <Bar
                            dataKey="count"
                            name="fetches"
                            fill="var(--primary)"
                            radius={[0, 4, 4, 0]}
                            maxBarSize={26}
                          >
                            <LabelList
                              dataKey="count"
                              position="right"
                              style={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                            />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </ChartCard>

                <ChartCard title="Formats">
                  {data.typeBreakdown.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground/70">No sources yet</p>
                  ) : (
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={data.typeBreakdown}
                            dataKey="count"
                            nameKey="type"
                            cx="50%"
                            cy="50%"
                            innerRadius={44}
                            outerRadius={72}
                            paddingAngle={2}
                            stroke="var(--background)"
                            strokeWidth={2}
                          >
                            {data.typeBreakdown.map((_, i) => (
                              <Cell
                                key={i}
                                fill={PALETTE[i % PALETTE.length]}
                              />
                            ))}
                          </Pie>
                          <Tooltip content={<ChartTooltip />} />
                        </PieChart>
                      </ResponsiveContainer>
                      <ul className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
                        {data.typeBreakdown.map((t, i) => (
                          <li
                            key={t.type}
                            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                          >
                            <span
                              className="inline-block h-2 w-2 rounded-full"
                              style={{
                                background: PALETTE[i % PALETTE.length],
                              }}
                              aria-hidden
                            />
                            <span className="font-mono lowercase text-foreground/80">
                              {t.type}
                            </span>
                            <span className="text-muted-foreground/70">
                              {formatNumber(t.count)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </ChartCard>

                <ChartCard title="Qualities">
                  {data.qualityBreakdown.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground/70">No quality data</p>
                  ) : (
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={data.qualityBreakdown.slice(0, 8)}
                          margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--border)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="quality"
                            tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                            stroke="var(--border)"
                            interval={0}
                            angle={-25}
                            textAnchor="end"
                            height={48}
                          />
                          <YAxis
                            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                            stroke="var(--border)"
                            allowDecimals={false}
                          />
                          <Tooltip
                            cursor={{ fill: "var(--accent)", opacity: 0.4 }}
                            content={<ChartTooltip />}
                          />
                          <Bar
                            dataKey="count"
                            name="sources"
                            fill="var(--primary)"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={36}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </ChartCard>

                <ChartCard title="Activity" className="lg:col-span-2">
                  {data.timeline.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground/70">No recent activity</p>
                  ) : (
                    <div className="h-[220px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart
                          data={data.timeline}
                          margin={{ top: 4, right: 12, bottom: 4, left: -8 }}
                        >
                          <defs>
                            <linearGradient
                              id="timelineGradient"
                              x1="0"
                              y1="0"
                              x2="0"
                              y2="1"
                            >
                              <stop
                                offset="0%"
                                stopColor="var(--primary)"
                                stopOpacity={0.45}
                              />
                              <stop
                                offset="100%"
                                stopColor="var(--primary)"
                                stopOpacity={0.02}
                              />
                            </linearGradient>
                          </defs>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--border)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="day"
                            tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                            stroke="var(--border)"
                            tickFormatter={(v: string) => v.slice(5)}
                            interval="preserveStartEnd"
                            minTickGap={16}
                          />
                          <YAxis
                            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                            stroke="var(--border)"
                            allowDecimals={false}
                            width={32}
                          />
                          <Tooltip
                            cursor={{ stroke: "var(--primary)", strokeWidth: 1 }}
                            content={<ChartTooltip />}
                          />
                          <Area
                            type="monotone"
                            dataKey="fetches"
                            name="fetches"
                            stroke="var(--primary)"
                            strokeWidth={2}
                            fill="url(#timelineGradient)"
                            dot={{
                              r: 2.5,
                              fill: "var(--primary)",
                              strokeWidth: 0,
                            }}
                            activeDot={{ r: 4 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </ChartCard>
              </div>

              <section className="rounded-xl border border-border/70 bg-card/40 p-3.5">
                <header className="mb-2 flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                  <h3 className="text-xs font-semibold text-foreground">Recent errors</h3>
                  <span className="ml-auto text-[11px] text-muted-foreground/70">
                    last {recentErrors.length}
                  </span>
                </header>
                {recentErrors.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground/70">None</p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {recentErrors.map((e, i) => (
                      <li
                        key={i}
                        className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:gap-3"
                      >
                        <span className="font-mono text-xs font-medium text-foreground">
                          {e.host}
                        </span>
                        <span className="line-clamp-1 flex-1 text-xs text-muted-foreground">
                          {truncateText(e.error)}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60 sm:ml-auto">
                          {relativeTime(e.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
