import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ImportItem {
  url: string;
  type: string;
  quality?: string | null;
  label?: string | null;
  ext?: string | null;
  size?: string | null;
}

interface ImportEntry {
  id?: string;
  url: string;
  host: string;
  title?: string | null;
  thumbnail?: string | null;
  count?: number;
  status?: string;
  error?: string | null;
  tookMs?: number | null;
  createdAt?: string;
  items?: ImportItem[];
}

/** POST /api/history/import — batch-import entries from an exported JSON file. */
export async function POST(req: NextRequest) {
  let body: { entries?: ImportEntry[] } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const entries = body.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return NextResponse.json({ ok: false, error: "No entries provided" }, { status: 400 });
  }

  let imported = 0;
  let skipped = 0;

  for (const entry of entries) {
    const url = (entry.url || "").trim();
    if (!url) {
      skipped++;
      continue;
    }

    // Determine host
    let host = entry.host || "unknown";
    if (!entry.host) {
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        // keep default
      }
    }

    // Skip if this exact URL was already fetched recently (within 5 min)
    try {
      const recent = await db.fetchHistory.findFirst({
        where: { url, createdAt: { gt: new Date(Date.now() - 5 * 60 * 1000) } },
        orderBy: { createdAt: "desc" },
      });
      if (recent) {
        skipped++;
        continue;
      }
    } catch {
      // DB error on check — skip this entry
      skipped++;
      continue;
    }

    const itemsData = (entry.items || []).slice(0, 12).map((s) => ({
      url: s.url,
      type: s.type || "unknown",
      quality: s.quality ?? null,
      label: s.label ?? null,
      ext: s.ext ?? null,
      size: s.size ?? null,
    }));

    try {
      const created = await db.fetchHistory.create({
        data: {
          url,
          host,
          title: (entry.title || "").slice(0, 240) || null,
          thumbnail: entry.thumbnail ?? null,
          count: entry.count ?? itemsData.length,
          status: entry.status || "ok",
          error: entry.error ?? null,
          tookMs: entry.tookMs ?? null,
          createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
          items: { create: itemsData },
        },
      });
      if (created) imported++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  return NextResponse.json({ ok: true, imported, skipped, total: entries.length });
}
