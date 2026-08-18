import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { DecodeText } from '@/components/brain/anim';
import { metric } from './ChartTheme';

/**
 * CortexGauge — health.md §1.
 * Large arc-reactor gauge (boot-reactor.svg, rings counter-rotating via CSS),
 * composite health score counted 0→N over 1200ms with sub-score ring segments
 * filling in sync; verdict decode-resolves after the count completes.
 */

function useCountUpValue(target: number, duration = 1200): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setV(target * (1 - Math.pow(2, -10 * p)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setV(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

function accuracy(mHit = metric('recall_hit'), mMiss = metric('recall_miss')): number {
  const h = mHit.sum;
  const ms = mMiss.sum;
  return h + ms === 0 ? 0 : h / (h + ms);
}

function accDelta7(): number {
  const hit = metric('recall_hit').series;
  const miss = metric('recall_miss').series;
  const acc = (from: number, to: number) => {
    let h = 0;
    let m = 0;
    for (let i = from; i < to; i++) {
      h += hit[i]?.value ?? 0;
      m += miss[i]?.value ?? 0;
    }
    return h + m === 0 ? 0 : h / (h + m);
  };
  return (acc(23, 30) - acc(16, 23)) * 100; // percentage points
}

export default function CortexGauge() {
  const [svg, setSvg] = useState('');

  const sub = useMemo(() => {
    const recall = accuracy();
    const compliance = metric('preference_compliance').avg;
    const bloat = metric('memory_bloat_ratio').latest;
    const score = Math.round(recall * 50 + compliance * 35 + (1 - bloat) * 15);
    return { recall, compliance, bloat, score: Math.min(99, score) };
  }, []);

  const score = useCountUpValue(sub.score, 1200);
  const deltas = useMemo(
    () => ({
      recall: accDelta7(),
      compliance: (metric('preference_compliance').series.slice(-7).reduce((a, p) => a + p.value, 0) / 7 -
        metric('preference_compliance').series.slice(-14, -7).reduce((a, p) => a + p.value, 0) / 7) * 100,
      bloat: (metric('memory_bloat_ratio').latest - metric('memory_bloat_ratio').series[22]?.value) * 100,
    }),
    [],
  );

  useEffect(() => {
    fetch('/boot-reactor.svg')
      .then((r) => r.text())
      .then(setSvg)
      .catch(() => setSvg(''));
  }, []);

  // drive the svg's segmented progress arc to the composite score
  useEffect(() => {
    if (!svg) return;
    const el = document.getElementById('progress-arc');
    if (el) {
      el.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(0.22,1,0.36,1)';
      requestAnimationFrame(() => {
        el.setAttribute('stroke-dashoffset', String(1306.9 * (1 - sub.score / 100)));
      });
    }
  }, [svg, sub.score]);

  const nominal = sub.score >= 80;
  const verdict = nominal ? 'CORTEX INTEGRITY NOMINAL' : 'CORTEX INTEGRITY DEGRADED';
  const verdictColor = nominal ? 'var(--ok)' : 'var(--reactor)';

  const rings = [
    { r: 176, v: sub.recall, color: '#00d4ff', label: 'recall' },
    { r: 164, v: sub.compliance, color: '#22ff88', label: 'compliance' },
    { r: 152, v: 1 - sub.bloat, color: '#ffb627', label: 'inverse bloat' },
  ];

  const readouts = [
    { label: 'RECALL ACCURACY', value: `${Math.round(sub.recall * 100)}%`, delta: deltas.recall, invert: false },
    { label: 'COMPLIANCE', value: `${Math.round(sub.compliance * 100)}%`, delta: deltas.compliance, invert: false },
    { label: 'BLOAT', value: sub.bloat.toFixed(2), delta: deltas.bloat, invert: true },
  ];

  return (
    <div className="flex flex-wrap items-center gap-8">
      {/* gauge */}
      <div className="relative h-[240px] w-[240px] shrink-0">
        {svg && (
          <div
            className="absolute inset-0 [&_svg]:h-full [&_svg]:w-full [&_#ring-outer]:[animation:spin-slow_20s_linear_infinite] [&_#ring-outer]:[transform-origin:256px_256px] [&_#ring-mid]:[animation:spin-slow_32s_linear_infinite_reverse] [&_#ring-mid]:[transform-origin:256px_256px] [&_#ring-inner]:[animation:spin-slow_26s_linear_infinite] [&_#ring-inner]:[transform-origin:256px_256px]"
            style={{ filter: 'drop-shadow(0 0 18px rgba(0,212,255,0.25))' }}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
        {/* sub-score ring segments */}
        <svg viewBox="0 0 512 512" className="absolute inset-0 h-full w-full -rotate-90">
          {rings.map((r) => (
            <motion.circle
              key={r.label}
              cx="256"
              cy="256"
              r={r.r}
              fill="none"
              stroke={r.color}
              strokeWidth="7"
              strokeLinecap="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: Math.min(1, Math.max(0, r.v)) }}
              transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
              style={{ filter: `drop-shadow(0 0 5px ${r.color})` }}
            >
              <title>{r.label}</title>
            </motion.circle>
          ))}
        </svg>
        {/* center score */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-[52px] font-bold leading-none text-hi" style={{ textShadow: '0 0 24px rgba(0,212,255,0.7)' }}>
            {Math.round(score)}
          </span>
          <span className="micro-label mt-1">cortex integrity</span>
          <div className="mt-1.5 flex gap-2">
            {rings.map((r) => (
              <span key={r.label} className="h-1 w-5 rounded-full" style={{ backgroundColor: r.color, boxShadow: `0 0 6px ${r.color}` }} />
            ))}
          </div>
        </div>
      </div>

      {/* verdict + readouts */}
      <div className="min-w-[240px] flex-1">
        <h2 className="font-display text-[18px] font-bold tracking-[0.14em] lg:text-[20px]" style={{ color: verdictColor, textShadow: `0 0 16px ${verdictColor}` }}>
          <DecodeText text={verdict} duration={600} delay={1250} />
        </h2>
        <p className="mt-1 font-mono text-[11px] text-dim">
          composite = recall 50% · compliance 35% · inverse-bloat 15%
        </p>
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
          {readouts.map((r, i) => {
            const good = r.invert ? r.delta <= 0 : r.delta >= 0;
            const Icon = good ? TrendingUp : TrendingDown;
            const color = good ? 'var(--ok)' : 'var(--danger)';
            return (
              <div key={r.label}>
                <div className="micro-label">{r.label}</div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="font-mono text-[22px] font-bold text-hi text-glow">{r.value}</span>
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 1.3 + i * 0.12, type: 'spring', stiffness: 400, damping: 15 }}
                    className="flex items-center gap-0.5 font-mono text-[11px] font-bold"
                    style={{ color }}
                  >
                    <Icon size={13} />
                    {Math.abs(r.delta).toFixed(1)}
                  </motion.span>
                </div>
                <div className="font-mono text-[9px] text-dim">7d delta {r.invert ? '(lower is better)' : 'pp'}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
