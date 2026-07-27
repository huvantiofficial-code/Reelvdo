"use client";

import { useCallback, useEffect, useState } from "react";

/** Persisted user preferences. Stored in localStorage under REEL_SETTINGS. */
export interface ReelSettings {
  /** "progress" (default) or "direct" — whether the Download button opens the
   *  progress dialog or navigates straight to the file. */
  downloadMode: "progress" | "direct";
  /** Auto-open the watch dialog after a successful extract. */
  autoWatch: boolean;
  /** Show the "Best" badge on the highest-quality source. */
  showBestBadge: boolean;
  /** Show keyboard hint kbd chips on source cards. */
  showKeyHints: boolean;
  /** Default history limit (entries shown in the panel). */
  historyLimit: number;
}

export const DEFAULT_SETTINGS: ReelSettings = {
  downloadMode: "progress",
  autoWatch: false,
  showBestBadge: true,
  showKeyHints: true,
  historyLimit: 20,
};

const KEY = "REEL_SETTINGS";

function readSettings(): ReelSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * useSettings — a tiny localStorage-backed settings hook. Reads on mount,
 * writes on change, and broadcasts a `storage`-like event so multiple hooks
 * in the same tab stay in sync.
 */
export function useSettings() {
  // Lazy initializer — reads from localStorage on first render (client-side
  // only; SSR returns defaults). Avoids a setState-in-effect cascade.
  const [settings, setSettings] = useState<ReelSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return readSettings();
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Re-read on mount in case the lazy init ran during SSR (where window is
    // undefined) — this is the only legitimate setState-in-effect here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(readSettings());
    setLoaded(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setSettings(readSettings());
    };
    const onCustom = () => setSettings(readSettings());
    window.addEventListener("storage", onStorage);
    window.addEventListener("reel-settings-change", onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("reel-settings-change", onCustom as EventListener);
    };
  }, []);

  const update = useCallback((patch: Partial<ReelSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
        window.dispatchEvent(new Event("reel-settings-change"));
      } catch {
        // ignore quota / private-mode errors
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(KEY);
      window.dispatchEvent(new Event("reel-settings-change"));
    } catch {
      // ignore
    }
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return { settings, update, reset, loaded };
}
