"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * useCountUp — animates a number from 0 → target over `duration` ms.
 *
 * - Uses requestAnimationFrame with an ease-out cubic curve.
 * - Only animates when `target` is positive and changes.
 * - Respects prefers-reduced-motion: returns target instantly.
 * - All setState calls happen inside the rAF callback (never synchronously
 *   in the effect body) to satisfy react-hooks/set-state-in-effect.
 */
export function useCountUp(target: number, duration = 900): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  // Reduced-motion preference is stable per session — read once.
  const prefersReduced = useMemo(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  useEffect(() => {
    // No animation when target is non-positive or user prefers reduced motion.
    if (target <= 0 || prefersReduced) return;

    startRef.current = null;
    const from = 0;
    const to = target;

    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(from + (to - from) * eased);
      // setState inside a rAF callback is allowed by the lint rule.
      setValue(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setValue(to);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, prefersReduced]);

  // Non-positive target → always 0.
  if (target <= 0) return 0;
  // Reduced motion → jump straight to target.
  if (prefersReduced) return target;
  return value;
}
