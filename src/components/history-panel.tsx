"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  History,
  Trash2,
  RotateCcw,
  Loader2,
  Clock,
  Check,
  AlertCircle,
  ExternalLink,
  Search,
  X,
  Download,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { HistoryEntry, HistoryResponse } from "@/lib/history-types";
import { toast } from "sonner";

interface HistoryPanelProps {
  /** Called when the user clicks "re-fetch" on an entry. */
  onRefetch: (url: string) => void;
  /** Refresh signal — parent can bump this to force a reload after a fetch. */
  refreshKey: number;
  /** Maximum number of entries to fetch from the API. */
  limit?: number;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function faviconUrl(host: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
}

export function HistoryPanel({ onRefetch, refreshKey, limit = 20 }: HistoryPanelProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/history?limit=${limit}`, { cache: "no-store" });
      const data: HistoryResponse = await r.json();
      setEntries(data.items || []);
      if (!data.ok) setErr(data.error || "Could not load history");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    if (open) load();
  }, [open, load, refreshKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.host.toLowerCase().includes(q) ||
        (e.title?.toLowerCase().includes(q) ?? false) ||
        e.url.toLowerCase().includes(q)
    );
  }, [entries, query]);

  const removeOne = async (id: string) => {
    const prev = entries;
    setEntries((e) => e.filter((x) => x.id !== id));
    try {
      await fetch(`/api/history/${id}`, { method: "DELETE" });
    } catch {
      setEntries(prev);
      toast.error("Could not delete entry");
    }
  };

  const clearAll = async () => {
    const prev = entries;
    setEntries([]);
    try {
      const r = await fetch("/api/history/clear", { method: "DELETE" });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      toast.success("History cleared");
    } catch (e) {
      setEntries(prev);
      toast.error(e instanceof Error ? e.message : "Could not clear");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const r = await fetch("/api/history/export", { cache: "no-store" });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Export failed");
      const exportPayload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: data.items,
      };
      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `reel-history-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Exported ${data.items.length} entr${data.items.length === 1 ? "y" : "ies"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      try {
        const text = await file.text();
        let parsed: { version?: number; entries?: unknown[] };
        try {
          parsed = JSON.parse(text);
        } catch {
          toast.error("Invalid JSON file");
          return;
        }
        if (!Array.isArray(parsed.entries)) {
          toast.error("Invalid export file: missing entries array");
          return;
        }
        const r = await fetch("/api/history/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: parsed.entries }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || "Import failed");
        toast.success(`Imported ${data.imported} entr${data.imported === 1 ? "y" : "ies"}${data.skipped > 0 ? ` (${data.skipped} skipped)` : ""}`);
        load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Import failed");
      } finally {
        setImporting(false);
      }
    };
    input.click();
  };

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 backdrop-blur-sm shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <History className="h-4 w-4 text-primary" />
          Recent fetches
          {entries.length > 0 && (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {entries.length}
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          {loading && (
            <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          )}

          {!loading && err && (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {err}
            </div>
          )}

          {!loading && !err && entries.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center">
              <Clock className="h-5 w-5 text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">
                Your fetched links will appear here.
              </p>
            </div>
          )}

          {!loading && !err && entries.length > 0 && (
            <>
              {/* Search box */}
              <div className="border-b border-border px-3 py-2">
                <div className="relative flex items-center">
                  <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground/60" />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search host or title…"
                    className="h-8 rounded-md border-border bg-background pl-8 pr-7 text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {query && (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                      className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {query && (
                  <p className="mt-1 px-0.5 text-[10px] text-muted-foreground/70">
                    {filtered.length} match{filtered.length === 1 ? "" : "es"} for
                    &ldquo;{query}&rdquo;
                  </p>
                )}
              </div>

              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center">
                  <Search className="h-5 w-5 text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground">
                    No matches for &ldquo;{query}&rdquo;.
                  </p>
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="mt-1 text-xs text-primary hover:underline"
                  >
                    Clear search
                  </button>
                </div>
              ) : (
                <ul className="scroll-thin max-h-96 divide-y divide-border overflow-y-auto">
                  {filtered.map((e) => (
                  <li
                    key={e.id}
                    className="group flex gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
                  >
                    {/* Favicon / thumbnail */}
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                      {e.thumbnail ? (
                        <img
                          src={e.thumbnail}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={(ev) => {
                            (ev.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ) : (
                        <img
                          src={faviconUrl(e.host)}
                          alt=""
                          className="h-4 w-4"
                          loading="lazy"
                          onError={(ev) => {
                            (ev.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      )}
                    </div>

                    {/* Body */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {e.title || e.host}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {e.host} · {timeAgo(e.createdAt)} · {e.count} source
                        {e.count === 1 ? "" : "s"}
                      </p>
                      {e.status === "error" && e.error && (
                        <p className="mt-0.5 truncate text-[11px] text-destructive/80">
                          {e.error}
                        </p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground"
                        aria-label="Re-fetch"
                        onClick={() => onRefetch(e.url)}
                        title="Re-fetch"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground"
                        aria-label="Open page"
                        asChild
                        title="Open page"
                      >
                        <a href={e.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        aria-label="Delete entry"
                        onClick={() => removeOne(e.id)}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
                </ul>
              )}
              <div className="flex items-center justify-between border-t border-border px-4 py-2">
                <span className="text-[11px] text-muted-foreground">
                  {query
                    ? `Showing ${filtered.length} of ${entries.length}`
                    : "Stored locally on this device."}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 text-xs text-muted-foreground"
                    onClick={handleExport}
                    disabled={exporting || importing}
                    title="Export history as JSON"
                  >
                    {exporting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Download className="h-3 w-3" />
                    )}
                    <span className="hidden sm:inline">Export</span>
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs text-muted-foreground"
                        disabled={exporting || importing}
                        title="Import history from JSON"
                      >
                        {importing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Upload className="h-3 w-3" />
                        )}
                        <span className="hidden sm:inline">Import</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Import history?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will add entries from a previously exported JSON file. Entries that were recently fetched (within 5 minutes) will be skipped to avoid duplicates.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleImport}>
                          <Upload className="mr-1 h-3.5 w-3.5" />
                          Choose file
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                        <span className="hidden sm:inline">Clear all</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Clear all history?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently removes all {entries.length} saved fetch
                          {entries.length === 1 ? "" : "es"}. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={clearAll}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          <Check className="mr-1 h-3.5 w-3.5" />
                          Clear all
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
