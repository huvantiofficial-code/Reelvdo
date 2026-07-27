import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/history/export — return ALL history entries with items (no limit). */
export async function GET() {
  try {
    const rows = await db.fetchHistory.findMany({
      orderBy: { createdAt: "desc" },
      include: { items: { orderBy: { id: "asc" } } },
    });
    return NextResponse.json({ ok: true, items: rows, total: rows.length });
  } catch (e) {
    return NextResponse.json(
      { ok: false, items: [], total: 0, error: e instanceof Error ? e.message : "DB error" },
      { status: 200 }
    );
  }
}
