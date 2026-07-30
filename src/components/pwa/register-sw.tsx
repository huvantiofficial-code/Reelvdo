"use client";

import { useEffect } from "react";

/**
 * Registers the Reel service worker (`/sw.js`) in production only.
 *
 * In development the SW is intentionally skipped to avoid caching live
 * source files and masking HMR / errors. Returns `null` - this component
 * is purely a side-effect.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        // Listen for updates and notify the waiting SW to activate.
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              // A new SW has taken over - could surface a toast here.
              console.info("[Reel PWA] Service worker updated.");
            }
          });
        });

        console.info("[Reel PWA] Service worker registered.", reg.scope);
      } catch (err) {
        console.warn("[Reel PWA] Service worker registration failed:", err);
      }
    };

    // Register after window load so it doesn't compete with first paint.
    if (document.readyState === "complete") {
      void register();
    } else {
      window.addEventListener("load", () => void register(), { once: true });
    }
  }, []);

  return null;
}
