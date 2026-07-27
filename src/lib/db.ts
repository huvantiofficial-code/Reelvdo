import { PrismaClient } from "@prisma/client";

// On Vercel (and other read-only-filesystem serverless platforms), the working
// directory is not writable. SQLite needs a writable file, so we redirect the
// database into /tmp (the only writable directory on Vercel serverless). This
// makes history work ephemerally on Vercel without any extra configuration.
// For persistent history, set DATABASE_URL to a real database (e.g. Turso).
if (process.env.VERCEL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:/tmp/reel.db";
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["query"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// ---- Best-effort schema bootstrap (for serverless / fresh DBs) -------------
// On platforms where `prisma db push` never ran (e.g. a fresh Vercel /tmp DB),
// the tables won't exist. We create them once, lazily, mirroring the Prisma
// schema's SQLite DDL. Failures are swallowed — all history routes already
// try/catch around DB calls, so the app degrades gracefully regardless.
let schemaEnsured = false;
const BOOTSTRAP_SQL = [
  `CREATE TABLE IF NOT EXISTS "FetchHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "title" TEXT,
    "thumbnail" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "error" TEXT,
    "tookMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "FetchItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "historyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quality" TEXT,
    "label" TEXT,
    "ext" TEXT,
    "size" TEXT,
    CONSTRAINT "FetchItem_historyId_fkey" FOREIGN KEY ("historyId") REFERENCES "FetchHistory" ("id") ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "FetchHistory_createdAt_idx" ON "FetchHistory"("createdAt")`,
  `CREATE INDEX IF NOT EXISTS "FetchHistory_host_idx" ON "FetchHistory"("host")`,
];

/** Ensure the SQLite tables exist. Safe to call repeatedly; no-op after success. */
export async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    for (const sql of BOOTSTRAP_SQL) {
      await db.$executeRawUnsafe(sql);
    }
    schemaEnsured = true;
  } catch {
    // Non-fatal: history routes handle missing tables gracefully.
  }
}
