import { useEffect, useState } from 'react';
import { getMetrics } from '@/lib/data';

/**
 * ArousalGauge — brain.md §1.
 * Horizontal amber meter (0–1): needle sweeps 0→value (800ms expo-out),
 * then idle sine oscillation ±0.03 (2.4s period). Shows implied temperature
 * multiplier from the arousal_modulation tracker.
 */
export default function ArousalGauge() {
  const latest = getMetrics('arousal_modulation')[0]?.latest ?? 0.34;
  const [v, setV] = useState(0);

  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const el = t - t0;
      if (el < 800) {
        const p = el / 800;
        setV(latest * (1 - Math.pow(2, -10 * p)));
      } else {
        setV(Math.min(1, Math.max(0, latest + 0.03 * Math.sin(((el - 800) / 2400) * Math.PI * 2))));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [latest]);

  const temp = 1 - 0.2 * v;

  return (
    <div className="w-[280px]">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="micro-label">Arousal</span>
        <span className="font-mono text-[13px] font-bold text-reactor" style={{ textShadow: '0 0 12px rgba(255,182,39,.6)' }}>
          {v.toFixed(2)} <span className="text-dim">→</span> TEMP ×{temp.toFixed(2)}
        </span>
      </div>
      <div className="relative h-[10px] overflow-hidden rounded-full border border-[rgba(255,182,39,0.35)] bg-[rgba(2,6,14,0.6)]">
        {/* fill */}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${v * 100}%`,
            background: 'linear-gradient(90deg, rgba(255,182,39,0.15), rgba(255,182,39,0.65))',
            boxShadow: '0 0 10px rgba(255,182,39,0.35)',
          }}
        />
        {/* tick marks */}
        {[0.25, 0.5, 0.75].map((t) => (
          <span key={t} className="absolute inset-y-0 w-px bg-[rgba(255,182,39,0.3)]" style={{ left: `${t * 100}%` }} />
        ))}
        {/* needle */}
        <span
          className="absolute top-[-2px] h-[14px] w-[2px] bg-reactor"
          style={{ left: `calc(${v * 100}% - 1px)`, boxShadow: '0 0 8px var(--reactor)' }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-dim">
        <span>0.0 CALM</span>
        <span>arousal_modulation</span>
        <span>1.0 ALERT</span>
      </div>
    </div>
  );
}
