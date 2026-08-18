import { useEffect, useRef, useState } from 'react';
import Lenis from 'lenis';

/**
 * Small shared HUD primitives for the data pages (Memory Index / Domain Atlas).
 * Kept out of the top-level shared components per assignment scope.
 */

/** Count-up numeral — 800ms expo-out from 0 whenever `value` changes. */
export function CountUp({
  value,
  decimals = 0,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 800);
      setV(value * (1 - Math.pow(2, -10 * p)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setV(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className={className}>{v.toFixed(decimals)}</span>;
}

const SCRAMBLE = '01<>/\\|#$%&@*+=?ABCDEF';

/** Decode text — characters scramble then resolve left→right over 600ms. */
export function DecodeText({
  text,
  className,
  duration = 600,
}: {
  text: string;
  className?: string;
  duration?: number;
}) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const n = Math.floor(p * text.length);
      if (p >= 1) {
        setOut(text);
        return;
      }
      setOut(
        text.slice(0, n) +
          text
            .slice(n)
            .split('')
            .map((c) => (c === ' ' ? ' ' : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]))
            .join(''),
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration]);
  return <span className={className}>{out}</span>;
}

/** Page-wide Lenis smooth scrolling — mounted by scrolling pages only. */
export function useLenis() {
  const ref = useRef<Lenis | null>(null);
  useEffect(() => {
    const lenis = new Lenis({ duration: 1.05, smoothWheel: true });
    ref.current = lenis;
    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
      ref.current = null;
    };
  }, []);
}

/** Relative time — `46d ago` style used across the data pages. */
export function timeAgo(isoDate: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Absolute timestamp for hover tooltips. */
export function absoluteTime(isoDate: string): string {
  return isoDate.slice(0, 16).replace('T', ' ') + ' UTC';
}
