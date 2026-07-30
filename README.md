# Video Downloader App

A modern web tool that extracts all playable video sources (HLS / DASH / MP4 / TS / WEBM and more) from any video-page URL, lets you preview them inline, and download with real progress tracking. Cloudflare-aware via `curl` (with a transparent native-`fetch` fallback for serverless platforms like Vercel).

Built with **Next.js 16**, **TypeScript**, **Tailwind CSS 4**, **shadcn/ui**, and **Prisma**.

---

## Features

- **Universal extraction** — paste any video-page URL; the app scans the HTML/JS for media URLs (`MDCore.wurl/hls`, `sources:[{file,label}]`, raw `.m3u8/.mpd/.mp4` links, etc.).
- **Site-specific extractors** — DoodStream, StreamWish (Swhoi / FileLions), FileMoon and more, with token-refresh logic for expiring CDN links.
- **Cloudflare bypass** — uses the system `curl` binary (whose TLS fingerprint passes many bot checks). On platforms without `curl` (Vercel serverless) it automatically falls back to native `fetch`.
- **Inline player** — HLS.js + native `<video>` for MP4/DASH/TS/WEBM, with a CORS proxy route for cross-origin streams.
- **Format filtering** — filter results by HLS / MP4 / DASH / TS / WEBM / audio.
- **Download with progress** — real byte progress (including synthetic Content-Length for HLS playlists).
- **History** — last 100 fetches with 30-day TTL, thumbnails, retry, delete, clear, plus export/import. Backed by Prisma + SQLite.
- **Insights dashboard** — KPI cards + 4 Recharts visualizations and a recent-errors list.
- **PWA** — installable, with manifest + service worker.
- **Polished UI** — glass-morphism, radial-gradient + grid background, shimmer/stagger/fade animations, full light & dark mode, responsive from 390px → 1280px.

---

## Tech stack

| Area        | Choice                                  |
| ----------- | --------------------------------------- |
| Framework   | Next.js 16 (App Router)                 |
| Language    | TypeScript 5                            |
| Styling     | Tailwind CSS 4 + shadcn/ui (New York)   |
| Database    | Prisma ORM + SQLite                     |
| State       | Zustand (client) + TanStack Query (server) |
| Player      | HLS.js + dashjs + native `<video>`      |
| Parsing     | cheerio                                 |

---

## Local development

```bash
# 1. Install dependencies
bun install

# 2. Create the SQLite database & tables
cp .env.example .env
bun run db:push

# 3. Start the dev server
bun run dev
```

The app runs on `http://localhost:3000`.

### Useful scripts

| Script              | Description                              |
| ------------------- | ---------------------------------------- |
| `bun run dev`       | Start the dev server (port 3000)         |
| `bun run build`     | Production build                         |
| `bun run start`     | Run the production build                 |
| `bun run lint`      | ESLint                                   |
| `bun run db:push`   | Push the Prisma schema to the database   |
| `bun run db:generate` | Regenerate the Prisma client           |

---

## Deploy on Vercel

This project is Vercel-ready out of the box.

1. Push this repository to GitHub.
2. Import it on [vercel.com](https://vercel.com/new) — Vercel auto-detects Next.js.
3. **Build command**: leave as default (`next build`). `prisma generate` runs automatically via the `postinstall` script.
4. **Environment variables** (optional): no variables are required to deploy. The app uses an ephemeral SQLite DB under `/tmp` on Vercel automatically.
   - For **persistent history**, set `DATABASE_URL` to a hosted database (e.g. [Turso](https://turso.tech) libSQL).

### How it works on Vercel

- **Fetching**: Vercel serverless has no `curl` binary, so the fetch layer transparently falls back to native `fetch` (same browser-like headers). Cloudflare-protected hosts may be harder to reach than on a local machine, but the vast majority of sites work.
- **History**: the filesystem is read-only except `/tmp`, so history is stored ephemerally at `file:/tmp/reel.db` (tables auto-created on first request). It survives within a warm instance but is not shared across instances — perfectly fine for a personal tool. Set `DATABASE_URL` for persistence.
- **HLS downloads (slow-connection friendly)**: HLS videos are downloaded segment-by-segment — each `.ts` segment is a separate short request (`/api/hls-segment`, ~1–3s each) that never hits the serverless timeout, even on a 1 Mbps connection. Pause/resume continues from the last successful segment (no restart-from-zero). The legacy long-lived `/api/stream` route is kept only as a fallback for direct MP4 downloads.
- **Function timeouts**: `vercel.json` pins each route's `maxDuration` to a value compatible with Vercel's plan limits (60s for metadata routes, 300s for streaming routes). Upgrade to Pro for the full 300s on `/api/stream` and `/api/proxy`; Hobby silently caps them at 60s (still functional for smaller files).

---

## Project structure

```
prisma/schema.prisma          # FetchHistory + FetchItem models
src/app/page.tsx              # Main UI (the only user-facing route)
src/app/api/                  # API routes (extract, history, proxy, stream, …)
src/lib/extractor.ts          # Generic video-source extraction
src/lib/site-extractors.ts    # Per-host extractors (DoodStream, StreamWish, …)
src/lib/curl-fetch.ts         # curl + native-fetch fetcher (Cloudflare-aware)
src/lib/curl-stream.ts        # Streaming fetch (curl + native-fetch fallback)
src/lib/db.ts                 # Prisma client + serverless schema bootstrap
src/components/               # UI components (cards, dialogs, player, history …)
public/                       # PWA icons, manifest, service worker
```

---

## License

MIT
