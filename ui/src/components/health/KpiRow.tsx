import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { CountUp } from '@/components/brain/anim';
import { metric, weekDelta } from './ChartTheme';
import type { Metric } from '@/lib/data';

/**
 * KpiRow — health.md §2.
 * Six ghost holo-cards: micro label, data-lg numeral, 7-day sparkline
 * (glowing polyline, dash-draw), delta chip. Staggered holo-reveal.
 */

interface Kpi {
  label: string;
  color: string;
  m: Metric;
  mode: 'sum' | 'avg';
  format: (v: number) => { value: number; decimals: number; suffix?: string };
}

const KPIS: () => Kpi[] = () => [
  { label: 'RECALL HITS', color: '#00d4ff', m: metric('recall_hit'), mode: 'sum', format: (v) => ({ value: v, decimals: 0 }) },
  { label: 'RECALL MISSES', color: '#ff3355', m: metric('recall_miss'), mode: 'sum', format: (v) => ({ value: v, decimals: 0 }) },
  { label: 'PREF COMPLIANCE', color: '#22ff88', m: metric('preference_compliance'), mode: 'avg', format: (v) => ({ value: v * 100, decimals: 1, suffix: '%' }) },
  { label: 'DUPLICATE RATE', color: '#ffb627', m: metric('duplicate_rate'), mode: 'avg', format: (v) => ({ value: v * 100, decimals: 1, suffix: '%' }) },
  { label: 'CORRECTIONS STORED', color: '#4da6ff', m: metric('correction_stored'), mode: 'sum', format: (v) => ({ value: v, decimals: 0 }) },
  { label: 'SCHEMAS FORMED', color: '#b26bff', m: metric('schema_formation'), mode: 'sum', format: (v) => ({ value: v, decimals: 0 }) },
];

function Sparkline({ points, color, delay }: { points: number[]; color: string; delay: number }) {
  const W = 96;
  const H = 30;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pts = points
    .map((v, i) => `${(i / (points.length - 1)) * W},${H - 3 - ((v - min) / span) * (H - 6)}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[30px] w-full" preserveAspectRatio="none">
      <motion.polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, delay, ease: 'easeOut' }}
        className="transition-[filter] duration-200 group-hover:drop-shadow-[0_0_6px_currentColor]"
        style={{ filter: `drop-shadow(0 0 3px ${color})`, color }}
      />
    </svg>
  );
}

export default function KpiRow() {
  const kpis = useMemo(KPIS, []);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {kpis.map((k, i) => {
        const raw = k.mode === 'sum' ? k.m.sum : k.m.avg;
        const f = k.format(raw);
        const delta = weekDelta(k.m, k.mode);
        const good = k.label === 'RECALL MISSES' || k.label === 'DUPLICATE RATE' ? delta <= 0 : delta >= 0;
        const spark = k.m.series.slice(-7).map((p) => p.value);
        return (
          <motion.div
            key={k.label}
            initial={{ clipPath: 'inset(0 100% 0 0)', opacity: 0 }}
            whileInView={{ clipPath: 'inset(0 0% 0 0)', opacity: 1 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: i * 0.07 }}
            whileHover={{ y: -2 }}
            className="holo-panel holo-panel-ghost holo-corners group relative p-3 transition-shadow duration-200 hover:shadow-glow-arc"
          >
            <div className="micro-label truncate">{k.label}</div>
            <div className="mt-1 flex items-baseline gap-0.5" style={{ color: k.color }}>
              <CountUp
                value={f.value}
                decimals={f.decimals}
                className="font-mono text-[24px] font-bold leading-none text-glow"
              />
              {f.suffix && <span className="font-mono text-[13px] font-bold opacity-70">{f.suffix}</span>}
            </div>
            <div className="mt-1.5" style={{ color: k.color }}>
              <Sparkline points={spark} color={k.color} delay={0.2 + i * 0.1} />
            </div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.7 + i * 0.1 }}
              className="mt-1 inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] font-mono text-[9.5px] font-bold"
              style={{
                color: good ? 'var(--ok)' : 'var(--danger)',
                borderColor: good ? 'rgba(34,255,136,0.35)' : 'rgba(255,51,85,0.35)',
                backgroundColor: good ? 'rgba(34,255,136,0.07)' : 'rgba(255,51,85,0.07)',
              }}
            >
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% · 7d
            </motion.div>
          </motion.div>
        );
      })}
    </div>
  );
}
