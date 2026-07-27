import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/stats — return aggregate usage stats. */
export async function GET() {
  try {
    const [totalFetches, sumResult, uniqueHostsResult] = await Promise.all([
      db.fetchHistory.count(),
      // Sum the `count` column (number of sources found per fetch).
      db.fetchHistory.aggregate({ _sum: { count: true } }),
      // Count distinct hosts.
      db.fetchHistory.findMany({
        select: { host: true },
        distinct: ["host"],
      }),
    ]);

    const totalSources = sumResult._sum.count ?? 0;
    const uniqueHosts = uniqueHostsResult.length;

    return NextResponse.json({
      ok: true,
      totalFetches,
      totalSources,
      uniqueHosts,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, totalFetches: 0, totalSources: 0, uniqueHosts: 0, error: e instanceof Error ? e.message : "DB error" },
      { status: 200 }
    );
  }
}
