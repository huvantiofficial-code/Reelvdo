"use client";

import { useEffect } from "react";

type KeyCombo = {
  /** Lowercase key, e.g. "k", "/", "Enter", "Escape". */
  key: string;
  /** Require Ctrl/Cmd? Default false. */
  mod?: boolean;
  /** Require Shift? Default false. */
  shift?: boolean;
  /** Require Alt? Default false. */
  alt?: boolean;
};

export interface ShortcutBinding extends KeyCombo {
  /** Handler invoked when the combo is pressed. */
  handler: (e: KeyboardEvent) => void;
  /** Don't fire when the active element is one of these tag names. */
  ignoreIn?: Array<"INPUT" | "TEXTAREA" | "SELECT">;
  /** Even when in an input, still fire (e.g. Escape). */
  allowInInput?: boolean;
}

function matches(e: KeyboardEvent, combo: KeyCombo): boolean {
  const key = e.key.toLowerCase();
  if (combo.key.toLowerCase() !== key) return false;
  const wantMod = combo.mod ?? false;
  const hasMod = e.ctrlKey || e.metaKey;
  if (wantMod !== hasMod) return false;
  if ((combo.shift ?? false) !== e.shiftKey) return false;
  if ((combo.alt ?? false) !== e.altKey) return false;
  return true;
}

/**
 * Register global keyboard shortcuts. Pass a stable list of bindings; the hook
 * re-subscribes whenever the list identity changes.
 */
export function useKeyboardShortcuts(bindings: ShortcutBinding[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        target?.isContentEditable === true;

      for (const b of bindings) {
        if (!matches(e, b)) continue;
        if (isEditable && !b.allowInInput) {
          // Only allow Escape-like keys to fire from inside inputs.
          if (b.key !== "escape") continue;
        }
        // If ignoreIn list explicitly excludes this tag, skip.
        if (b.ignoreIn?.some((t) => t === tag)) continue;
        e.preventDefault();
        b.handler(e);
        break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings]);
}

/** Pretty-print a key combo for display in the help popover. */
export function describeCombo(combo: KeyCombo): string {
  const isMac =
    typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "");
  const parts: string[] = [];
  if (combo.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (combo.shift) parts.push("⇧");
  if (combo.alt) parts.push(isMac ? "⌥" : "Alt");
  const k = combo.key;
  if (k === "/") parts.push("/");
  else if (k === "enter") parts.push("↵");
  else if (k === "escape") parts.push("Esc");
  else parts.push(k.toUpperCase());
  return parts.join(isMac ? "" : "+");
}
