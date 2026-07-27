import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shape of the aggregated insights payload returned by GET /api/insights. */
export interface InsightsPayload {
  totalFetches: number;
  totalSources: number;
  successRate: number; // 0-100
  avgTakeMs: number;
  hostsBar: { host: string; count: number; sources: number }[];
  typeBreakdown: { type: string; count: number }[];
  qualityBreakdown: { quality: string; count: number }[];
  timeline: { day: string; fetches: number; sources: number }[];
  recentErrors: { host: string; error: string; createdAt: string }[];
}

/** Cache result for 60 seconds in module memory (best-effort). */
const CACHE_TTL_MS = 60_000;
let cachedAt = 0;
let cachedPayload: InsightsPayload | null = null;

/** Number of recent days to include in the timeline series. */
const TIMELINE_DAYS = 14;
/** Max number of hosts to show in the bar chart. */
const HOST_LIMIT = 10;
/** Number of recent errors to return. */
const ERRORS_LIMIT = 5;

/** Format a Date as "YYYY-MM-DD" (local time, no TZ shift surprises). */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Build the full insights payload from the database. */
async function buildInsights(): Promise<InsightsPayload> {
  // Aggregate everything in parallel where possible.
  const [
    totalCount,
    successCount,
    sumResult,
    avgResult,
    hostGroups,
    typeGroups,
    qualityGroups,
    recentErrorsRaw,
    recentRows,
  ] = await Promise.all([
    db.fetchHistory.count(),
    db.fetchHistory.count({ where: { status: "ok" } }),
    db.fetchHistory.aggregate({ _sum: { count: true } }),
    db.fetchHistory.aggregate({ _avg: { tookMs: true } }),
    db.fetchHistory.groupBy({
      by: ["host"],
      _count: { _all: true },
      _sum: { count: true },
      orderBy: { _count: { host: "desc" } },
      take: HOST_LIMIT,
    }),
    db.fetchItem.groupBy({
      by: ["type"],
      _count: { _all: true },
      orderBy: { _count: { type: "desc" } },
    }),
    db.fetchItem.groupBy({
      by: ["quality"],
      _count: { _all: true },
      orderBy: { _count: { quality: "desc" } },
    }),
    db.fetchHistory.findMany({
      where: { status: "error" },
      orderBy: { createdAt: "desc" },
      take: ERRORS_LIMIT,
      select: { host: true, error: true, createdAt: true },
    }),
    db.fetchHistory.findMany({
      where: { createdAt: { gte: new Date(Date.now() - TIMELINE_DAYS * 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, count: true },
    }),
  ]);

  const totalFetches = totalCount;
  const totalSources = sumResult._sum.count ?? 0;
  const successRate = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;
  const avgTakeMs = Math.round(avgResult._avg.tookMs ?? 0);

  // Hosts bar: top N by fetch count.
  const hostsBar = hostGroups.map((g) => ({
    host: g.host,
    count: g._count._all,
    sources: g._sum.count ?? 0,
  }));

  // Format distribution (FetchItem.type).
  const typeBreakdown = typeGroups.map((g) => ({
    type: g.type || "unknown",
    count: g._count._all,
  }));

  // Quality distribution (FetchItem.quality) — exclude null qualities.
  const qualityBreakdown = qualityGroups
    .filter((g) => g.quality && g.quality.trim().length > 0)
    .map((g) => ({
      quality: g.quality as string,
      count: g._count._all,
    }));

  // Recent errors.
  const recentErrors = recentErrorsRaw.map((r) => ({
    host: r.host,
    error: r.error ?? "Unknown error",
    createdAt: r.createdAt.toISOString(),
  }));

  // Timeline: last N days, group by day in JS.
  // NOTE: store entries by reference — we mutate them in the loop below and
  // then build the final array from the map so the counts propagate.
  const orderedKeys: string[] = [];
  const dayMap = new Map<string, { day: string; fetches: number; sources: number }>();
  for (let i = TIMELINE_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = ymd(d);
    orderedKeys.push(key);
    dayMap.set(key, { day: key, fetches: 0, sources: 0 });
  }
  for (const row of recentRows) {
    const key = ymd(row.createdAt);
    const entry = dayMap.get(key);
    if (entry) {
      entry.fetches += 1;
      entry.sources += row.count ?? 0;
    }
  }
  const days = orderedKeys.map((k) => dayMap.get(k)!);

  return {
    totalFetches,
    totalSources,
    successRate,
    avgTakeMs,
    hostsBar,
    typeBreakdown,
    qualityBreakdown,
    timeline: days,
    recentErrors,
  };
}

/** GET /api/insights — aggregated stats for the dashboard. */
export async function GET() {
  // Return cached payload if fresh.
  if (cachedPayload && Date.now() - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cachedPayload);
  }

  try {
    const payload = await buildInsights();
    cachedPayload = payload;
    cachedAt = Date.now();
    return NextResponse.json(payload);
  } catch (e) {
    // On error, return a graceful empty payload so the UI never crashes.
    const empty: InsightsPayload = {
      totalFetches: 0,
      totalSources: 0,
      successRate: 0,
      avgTakeMs: 0,
      hostsBar: [],
      typeBreakdown: [],
      qualityBreakdown: [],
      timeline: [],
      recentErrors: [],
    };
    return NextResponse.json(
      { ...empty, error: e instanceof Error ? e.message : "DB error" },
      { status: 200 }
    );
  }
}
