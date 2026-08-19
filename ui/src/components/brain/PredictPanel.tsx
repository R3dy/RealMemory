import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import HoloPanel from '@/components/HoloPanel';
import { getMetrics } from '@/lib/data';
import { PREDICTION_ERROR_COLORS } from '@/lib/colors';
import { CountUp, hexA } from './anim';
import { useBrainEventsByKind } from '@/lib/use-brain-stream';

/**
 * PredictPanel — brain.md §4.
 * Rescorla–Wagner prediction-error learning: semicircular surprise meter,
 * low|med|high distribution donut, open-predictions list with live outcomes.
 * Driven by real `predict.made` → `predict.resolved` events (synthetic-self
 * Phase 8) — no Math.random. surprise ≥ 0.7 → instant reflex rule.
 */

interface Prediction {
  id: number;
  text: string;
  conf: number;
  status: 'open' | 'hit' | 'surprise';
  err?: number;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 180) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

export default function PredictPanel() {
  const totals = useMemo(() => {
    const sum = (n: string) => Math.round(getMetrics(n)[0]?.sum ?? 0);
    return { low: sum('prediction_error:low'), med: sum('prediction_error:med'), high: sum('prediction_error:high') };
  }, []);
  const [dist, setDist] = useState(totals);
  const [surprise, setSurprise] = useState(0);
  const [preds, setPreds] = useState<Prediction[]>([]);
  const seq = useRef(0);

  // Real event-driven: predict.made opens a prediction; predict.resolved closes it.
  const madeEvents = useBrainEventsByKind(['predict.made']);
  const resolvedEvents = useBrainEventsByKind(['predict.resolved']);

  // Open predictions from predict.made events.
  useEffect(() => {
    if (madeEvents.length === 0) return;
    const latest = madeEvents[madeEvents.length - 1]!;
    const id = ++seq.current;
    const tool = (latest.payload.tool as string) ?? 'unknown';
    const conf = (latest.payload.confidence as number) ?? 0.5;
    setPreds((prev) =>
      [...prev, { id, text: `"${tool}" succeeds`, conf, status: 'open' as const }].slice(-7),
    );
  }, [madeEvents]);

  // Resolved predictions from predict.resolved events.
  useEffect(() => {
    if (resolvedEvents.length === 0) return;
    const latest = resolvedEvents[resolvedEvents.length - 1]!;
    const surpriseVal = (latest.payload.surprise as number) ?? 0;
    const bin = (latest.payload.bin as string) ?? 'low';
    const isSurprise = surpriseVal >= 0.7;
    setSurprise(surpriseVal);
    setDist((d) => {
      if (bin === 'high') return { ...d, high: d.high + 1 };
      if (bin === 'med') return { ...d, med: d.med + 1 };
      return { ...d, low: d.low + 1 };
    });
    // Close the oldest open prediction.
    setPreds((prev) => {
      const openIdx = prev.findIndex((r) => r.status === 'open');
      if (openIdx === -1) return prev;
      const next = [...prev];
      next[openIdx] = {
        ...next[openIdx],
        status: isSurprise ? 'surprise' : 'hit',
        err: isSurprise ? surpriseVal : undefined,
      };
      return next;
    });
  }, [resolvedEvents]);

  const total = dist.low + dist.med + dist.high;
  const C = 2 * Math.PI * 46; // donut circumference
  const segments: { key: 'low' | 'med' | 'high'; value: number }[] = [
    { key: 'low', value: dist.low },
    { key: 'med', value: dist.med },
    { key: 'high', value: dist.high },
  ];
  let acc = 0;
  const donut = segments.map((s) => {
    const frac = total > 0 ? s.value / total : 0;
    const seg = { ...s, offset: acc, frac };
    acc += frac;
    return seg;
  });

  // surprise meter geometry — semicircle 0..180° (needle rests at 0°, group rotates)
  const needleDeg = Math.min(1, Math.max(0, surprise)) * 180;
  const [nx, ny] = polar(80, 74, 52, 0);
  const zones = [
    { from: 0, to: 0.4 * 180, color: PREDICTION_ERROR_COLORS.low, label: 'LOW' },
    { from: 0.4 * 180, to: 0.7 * 180, color: PREDICTION_ERROR_COLORS.med, label: 'MED' },
    { from: 0.7 * 180, to: 180, color: PREDICTION_ERROR_COLORS.high, label: 'HIGH' },
  ];

  return (
    <HoloPanel
      title="PREDICT · SURPRISE ENGINE"
      className="h-full"
      headerRight={<span className="micro-label">Rescorla–Wagner</span>}
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-around gap-4">
          {/* surprise meter */}
          <div className="flex flex-col items-center">
            <svg viewBox="0 0 160 88" className="w-[170px]" role="img" aria-label={`Surprise ${surprise.toFixed(2)}`}>
              {zones.map((z) => (
                <path
                  key={z.label}
                  d={arc(80, 74, 60, z.from + 1.5, z.to - 1.5)}
                  stroke={z.color}
                  strokeWidth="7"
                  fill="none"
                  strokeLinecap="round"
                  opacity={0.45}
                />
              ))}
              {/* active zone glow */}
              <path
                d={arc(80, 74, 60, 0, needleDeg)}
                stroke="#7de9ff"
                strokeWidth="2"
                fill="none"
                opacity={0.35}
              />
              <motion.g
                animate={{ rotate: needleDeg }}
                initial={{ rotate: 0 }}
                transition={{ type: 'spring', stiffness: 110, damping: 9, mass: 0.9 }}
                style={{ transformOrigin: '80px 74px' }}
              >
                <line x1="80" y1="74" x2={nx} y2={ny} stroke="#e8f6ff" strokeWidth="2.5" strokeLinecap="round" />
              </motion.g>
              <circle cx="80" cy="74" r="4.5" fill="var(--space)" stroke="#7de9ff" strokeWidth="2" />
              {zones.map((z) => {
                const mid = (z.from + z.to) / 2;
                const [lx, ly] = polar(80, 74, 72, mid);
                return (
                  <text key={z.label} x={lx} y={ly + 3} textAnchor="middle" fill={z.color} fontSize="7.5" fontFamily="Orbitron, sans-serif" fontWeight="700">
                    {z.label}
                  </text>
                );
              })}
            </svg>
            <div className="-mt-2 text-center">
              <span className="font-mono text-[20px] font-bold text-hi text-glow">{surprise.toFixed(2)}</span>
              <div className="micro-label">surprise |δ|</div>
            </div>
          </div>

          {/* distribution donut */}
          <div className="flex flex-col items-center">
            <div className="relative">
              <svg viewBox="0 0 120 120" className="h-[120px] w-[120px] -rotate-90">
                {donut.map((s) => (
                  <motion.circle
                    key={s.key}
                    cx="60"
                    cy="60"
                    r="46"
                    fill="none"
                    stroke={PREDICTION_ERROR_COLORS[s.key]}
                    strokeWidth="12"
                    strokeDasharray={`${Math.max(0, s.frac * C - 3)} ${C}`}
                    initial={false}
                    animate={{ strokeDashoffset: -s.offset * C }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                    style={{ filter: `drop-shadow(0 0 4px ${hexA(PREDICTION_ERROR_COLORS[s.key], 0.6)})` }}
                  />
                ))}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-[18px] font-bold text-hi text-glow">
                  <CountUp value={total} />
                </span>
                <span className="micro-label">events</span>
              </div>
            </div>
            <div className="mt-1.5 flex gap-3 font-mono text-[10px]">
              {donut.map((s) => (
                <span key={s.key} style={{ color: PREDICTION_ERROR_COLORS[s.key] }}>
                  {s.key} {s.value}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* open predictions */}
        <div>
          <div className="micro-label mb-1.5">openPredictions · working-memory slot</div>
          <div className="flex flex-col gap-1">
            <AnimatePresence initial={false}>
              {preds.map((p) => (
                <motion.div
                  layout="position"
                  key={p.id}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="relative overflow-hidden rounded border border-panel-border bg-[rgba(2,6,14,0.5)] px-2.5 py-1.5"
                >
                  {p.status === 'surprise' && (
                    <motion.span
                      className="absolute inset-0"
                      style={{ background: 'radial-gradient(ellipse at center, rgba(255,51,85,0.25), transparent 70%)' }}
                      initial={{ opacity: 1, scale: 0.8 }}
                      animate={{ opacity: 0, scale: 1.2 }}
                      transition={{ duration: 0.8 }}
                    />
                  )}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={p.status}
                      initial={{ rotateX: 90, opacity: 0 }}
                      animate={{ rotateX: 0, opacity: 1 }}
                      exit={{ rotateX: -90, opacity: 0 }}
                      transition={{ duration: 0.35 }}
                      className="flex items-baseline gap-2 font-mono text-[11px]"
                    >
                      {p.status === 'open' && (
                        <>
                          <span className="text-reactor">⧗</span>
                          <span className="min-w-0 truncate text-mid">expect: {p.text}</span>
                          <span className="ml-auto shrink-0 text-dim">conf {p.conf.toFixed(2)}</span>
                        </>
                      )}
                      {p.status === 'hit' && (
                        <>
                          <span className="text-ok">✓</span>
                          <span className="min-w-0 truncate text-ok">predicted · {p.text}</span>
                          <span className="ml-auto shrink-0 text-dim">|δ| &lt; 0.4 → reinforced</span>
                        </>
                      )}
                      {p.status === 'surprise' && (
                        <>
                          <span className="text-danger">✗</span>
                          <span className="min-w-0 truncate text-danger">
                            SURPRISE {p.err?.toFixed(2)} → lesson encoded
                          </span>
                          <span className="ml-auto shrink-0 text-dim">{p.text}</span>
                        </>
                      )}
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        <div className="font-mono text-[10px] text-dim">surprise ≥ 0.7 → instant reflex rule</div>
      </div>
    </HoloPanel>
  );
}
