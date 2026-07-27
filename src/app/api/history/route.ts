import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import type { ExtractResult, VideoSource } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Maximum number of history rows kept around. Older rows are pruned. */
const HISTORY_CAP = 100;
/** Rows older than this many days are pruned regardless of count. */
const HISTORY_TTL_DAYS = 30;

/** Prune old + excess history. Best-effort; never fails the request. */
async function pruneHistory() {
  try {
    const ttlCutoff = new Date(Date.now() - HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000);
    // 1. Delete anything older than the TTL.
    const ttlRows = await db.fetchHistory.findMany({
      where: { createdAt: { lt: ttlCutoff } },
      select: { id: true },
    });
    if (ttlRows.length > 0) {
      await db.fetchItem.deleteMany({
        where: { historyId: { in: ttlRows.map((r) => r.id) } },
      });
      await db.fetchHistory.deleteMany({
        where: { id: { in: ttlRows.map((r) => r.id) } },
      });
    }

    // 2. If we still have more than the cap, trim to the newest N.
    const total = await db.fetchHistory.count();
    if (total > HISTORY_CAP) {
      const excess = await db.fetchHistory.findMany({
        orderBy: { createdAt: "desc" },
        skip: HISTORY_CAP,
        select: { id: true },
      });
      if (excess.length > 0) {
        const ids = excess.map((r) => r.id);
        await db.fetchItem.deleteMany({ where: { historyId: { in: ids } } });
        await db.fetchHistory.deleteMany({ where: { id: { in: ids } } });
      }
    }
  } catch {
    // ignore — best-effort cleanup
  }
}

/** GET /api/history?limit=20 — list recent fetches (newest first). */
export async function GET(req: NextRequest) {
  const limit = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get("limit") || "20", 10) || 20, 1),
    100
  );
  await ensureSchema();
  try {
    const rows = await db.fetchHistory.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { items: { take: 12, orderBy: { id: "asc" } } },
    });
    return NextResponse.json({ ok: true, items: rows });
  } catch (e) {
    return NextResponse.json(
      { ok: false, items: [], error: e instanceof Error ? e.message : "DB error" },
      { status: 200 }
    );
  }
}

/** POST /api/history — save a fetch result. Body: { url, result }. */
export async function POST(req: NextRequest) {
  let body: {
    url?: string;
    result?: ExtractResult;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const url = (body.url || "").trim();
  const result = body.result;
  if (!url || !result) {
    return NextResponse.json({ ok: false, error: "Missing url or result" }, { status: 400 });
  }

  let host = "unknown";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // keep default
  }

  await ensureSchema();
  try {
    // Avoid duplicates: if the same URL was fetched in the last 5 minutes, update it.
    const recent = await db.fetchHistory.findFirst({
      where: { url, createdAt: { gt: new Date(Date.now() - 5 * 60 * 1000) } },
      orderBy: { createdAt: "desc" },
    });

    const itemsData = (result.sources || []).slice(0, 12).map((s: VideoSource) => ({
      url: s.url,
      type: s.type,
      quality: s.quality ?? null,
      label: s.label ?? null,
      ext: s.ext ?? null,
      size: s.size ?? null,
    }));

    if (recent) {
      // Replace items.
      await db.fetchItem.deleteMany({ where: { historyId: recent.id } });
      const updated = await db.fetchHistory.update({
        where: { id: recent.id },
        data: {
          host,
          title: result.meta?.title?.slice(0, 240) ?? null,
          thumbnail: result.meta?.thumbnail ?? null,
          count: result.sources?.length ?? 0,
          status: result.ok ? "ok" : "error",
          error: result.error ?? null,
          tookMs: result.took ?? null,
          createdAt: new Date(),
          items: { create: itemsData },
        },
      });
      // Best-effort prune.
      pruneHistory();
      return NextResponse.json({ ok: true, id: updated.id });
    }

    const created = await db.fetchHistory.create({
      data: {
        url,
        host,
        title: result.meta?.title?.slice(0, 240) ?? null,
        thumbnail: result.meta?.thumbnail ?? null,
        count: result.sources?.length ?? 0,
        status: result.ok ? "ok" : "error",
        error: result.error ?? null,
        tookMs: result.took ?? null,
        items: { create: itemsData },
      },
    });
    // Best-effort prune.
    pruneHistory();
    return NextResponse.json({ ok: true, id: created.id });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "DB error" },
      { status: 200 }
    );
  }
}
