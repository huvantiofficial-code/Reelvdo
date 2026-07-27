import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/history/clear — wipe all history. */
export async function DELETE() {
  try {
    // Delete items first via cascade (set onDelete: Cascade), but Prisma's
    // SQLite doesn't always honour that on bulk delete — so be explicit.
    await db.fetchItem.deleteMany({});
    await db.fetchHistory.deleteMany({});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "DB error" },
      { status: 200 }
    );
  }
}
