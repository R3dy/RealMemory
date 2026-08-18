import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import Lenis from 'lenis';
import { useUiStore } from '@/lib/ui-store';

/** Smooth page scroll (Lenis) for scrolling pages — design.md §5. */
export function useLenis() {
  const { reducedMotion } = useUiStore();
  useEffect(() => {
    if (reducedMotion) return;
    const lenis = new Lenis({ autoRaf: true, lerp: 0.12 });
    return () => {
      lenis.destroy();
    };
  }, [reducedMotion]);
}

/** One-shot IntersectionObserver hook (for scroll-into-view chart animation). */
export function useInView<T extends HTMLElement>(threshold = 0.25) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return { ref, inView };
}

/** Count-up numeral — 800ms expo-out on mount / value change (design.md §5). */
export function CountUp({
  value,
  decimals = 0,
  duration = 800,
  className,
}: {
  value: number;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setV(value * (1 - Math.pow(2, -10 * p)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setV(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className={className}>{v.toFixed(decimals)}</span>;
}

const SCRAMBLE = '01<>/\\|#$%&@*+=?ABCDEF';

/** Decode text — HUD labels scramble then resolve (design.md §5, boot/page transitions). */
export function DecodeText({
  text,
  duration = 600,
  delay = 0,
  className,
}: {
  text: string;
  duration?: number;
  delay?: number;
  className?: string;
}) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    let raf = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t + delay;
      const p = Math.min(1, Math.max(0, (t - start) / duration));
      const n = Math.floor(p * text.length);
      setOut(
        text.slice(0, n) +
          text
            .slice(n)
            .split('')
            .map((c) => (c === ' ' ? ' ' : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]))
            .join(''),
      );
      if (p < 1) raf = requestAnimationFrame(tick);
      else setOut(text);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration, delay]);
  return <span className={className}>{out}</span>;
}

/** Holo-reveal panel entrance — clip-path wipe, 450ms expo-out (design.md §5). */
export function Reveal({
  children,
  className,
  delay = 0,
  amount = 0.25,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  amount?: number;
}) {
  return (
    <motion.div
      initial={{ clipPath: 'inset(0 100% 0 0)', opacity: 0 }}
      whileInView={{ clipPath: 'inset(0 0% 0 0)', opacity: 1 }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** UTC timestamp for telemetry logs: HH:MM:SS */
export function tsNow(): string {
  return new Date().toISOString().slice(11, 19);
}

export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
