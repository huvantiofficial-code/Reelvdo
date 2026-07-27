"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * InstallPrompt
 *
 * Listens for the browser's `beforeinstallprompt` event, captures it,
 * and surfaces a Sonner toast with an "Install" action — but only after
 * the user's second visit (i.e. they have opened the app before, tracked
 * via localStorage). Dismissing the toast sets a session flag so it
 * doesn't reappear within the same session.
 */

const VISIT_KEY = "reel.pwa.visitCount";
const DISMISS_KEY = "reel.pwa.installDismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export default function InstallPrompt() {
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);
  const shownRef = useRef(false);

  const triggerInstall = async () => {
    const deferred = deferredRef.current;
    if (!deferred) return;
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      console.info(`[Reel PWA] Install prompt outcome: ${choice.outcome}`);
      deferredRef.current = null;
    } catch (err) {
      console.warn("[Reel PWA] Install prompt failed:", err);
    }
  };

  const showInstallToast = () => {
    if (shownRef.current) return;
    shownRef.current = true;
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }

    toast("Install Reel for offline access", {
      description:
        "Add Reel to your home screen — fetch & download videos even when you're offline.",
      action: {
        label: "Install",
        onClick: () => void triggerInstall(),
      },
      duration: 8000,
      dismissible: true,
    });
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    // --- Track visit count for "second visit" gating ---
    try {
      const raw = window.localStorage.getItem(VISIT_KEY);
      const count = raw ? Number.parseInt(raw, 10) || 0 : 0;
      window.localStorage.setItem(VISIT_KEY, String(count + 1));
    } catch {
      // localStorage may be unavailable (private mode); fail silently.
    }

    const isSecondVisit = (() => {
      try {
        const count = Number.parseInt(
          window.localStorage.getItem(VISIT_KEY) || "0",
          10
        );
        return count >= 2;
      } catch {
        return false;
      }
    })();

    const isDismissedThisSession = (() => {
      try {
        return window.sessionStorage.getItem(DISMISS_KEY) === "1";
      } catch {
        return false;
      }
    })();

    // --- Capture the install prompt event ---
    const onBeforeInstallPrompt = (e: Event) => {
      // Prevent the default mini-info bar on mobile.
      e.preventDefault();
      deferredRef.current = e as BeforeInstallPromptEvent;

      // Only show if we're on a second visit AND not dismissed this session.
      if (!isSecondVisit || isDismissedThisSession || shownRef.current) return;
      showInstallToast();
    };

    const onAppInstalled = () => {
      console.info("[Reel PWA] App installed successfully.");
      deferredRef.current = null;
      shownRef.current = true;
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  return null;
}
