import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import HoloPanel from '@/components/HoloPanel';
import { MEMORIES, NOW_ISO } from '@/lib/data';
import type { Memory } from '@/lib/data';
import { ARCHIVE_THRESHOLD, weightColor } from '@/lib/colors';
import { useInView } from '@/components/brain/anim';

/**
 * MemoryPhysics — health.md §5.
 * A: DECAY CURVE — w(t) = w₀·e^(-λt), 30-day half-life, 0→90 day calendar
 *    window ending today; red dashed 0.05 auto-archive line; three sample
 *    memories plotted at current weight on the pulsing TODAY line.
 * B: WEIGHT DISTRIBUTION — corpus histogram in 0.05 buckets, tier-colored,
 *    red archive zone < 0.05.
 */

const DAY = 86_400_000;
const LAMBDA = Math.LN2 / 30; // 30-day half-life

interface Sample {
  m: Memory;
  ageDays: number;
  w0: number;
  archiveIn: number;
}

function pickSamples(): Sample[] {
  const now = new Date(NOW_ISO).getTime();
  const candidates = MEMORIES.filter((m) => m.status === 'active').map((m) => {
    const ageDays = (now - new Date(m.createdAt).getTime()) / DAY;
    return { m, ageDays };
  });
  const pickOne = (pred: (c: { m: Memory; ageDays: number }) => boolean) =>
    candidates
      .filter(pred)
      .sort((a, b) => b.m.accessCount - a.m.accessCount)[0];
  const chosen = [
    pickOne((c) => c.m.weight > 0.6 && c.ageDays < 30),
    pickOne((c) => c.m.type === 'lesson_learned' && c.m.weight > 0.25 && c.m.weight <= 0.6 && c.ageDays >= 20),
    pickOne((c) => c.m.weight <= 0.25 && c.ageDays >= 40),
  ].filter((s): s is { m: Memory; ageDays: number } => !!s);
  return chosen.map(({ m, ageDays }) => ({
    m,
    ageDays,
    w0: Math.min(1, m.weight * Math.exp(LAMBDA * ageDays)),
    archiveIn: Math.log(m.weight / ARCHIVE_THRESHOLD) / LAMBDA,
  }));
}

export function DecayCurve() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const samples = useMemo(pickSamples, []);
  const [hover, setHover] = useState<number | null>(null);

  const W = 560;
  const H = 250;
  const PL = 36;
  const PR = 14;
  const PT = 14;
  const PB = 26;
  const x = (d: number) => PL + (d / 90) * (W - PL - PR);
  const y = (w: number) => PT + (1 - w) * (H - PT - PB);

  const curve = (s: Sample): string => {
    const c = 90 - s.ageDays; // creation day in window coords
    const pts: string[] = [];
    for (let d = Math.max(0, c); d <= 90; d += 2) {
      const w = s.w0 * Math.exp(-LAMBDA * (d - c));
      pts.push(`${pts.length === 0 ? 'M' : 'L'} ${x(d).toFixed(1)} ${y(w).toFixed(1)}`);
    }
    return pts.join(' ');
  };

  return (
    <HoloPanel
      title="DECAY CURVE · w(t) = w₀·e^(−λt)"
      className="h-full"
      headerRight={<span className="micro-label">half-life 30d</span>}
    >
      <div ref={ref} className="relative p-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
          {/* grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={PL} y1={y(t)} x2={W - PR} y2={y(t)} stroke="rgba(0,212,255,.07)" />
              <text x={PL - 6} y={y(t) + 3} textAnchor="end" fill="#4b5f7c" fontSize="9" fontFamily="'JetBrains Mono', monospace">
                {t.toFixed(2)}
              </text>
            </g>
          ))}
          {[0, 30, 60, 90].map((d) => (
            <text key={d} x={x(d)} y={H - 8} textAnchor="middle" fill="#4b5f7c" fontSize="9" fontFamily="Orbitron, sans-serif">
              {d === 90 ? 'today' : `-${90 - d}d`}
            </text>
          ))}

          {inView && (
            <>
              {/* per-memory decay curves */}
              {samples.map((s, i) => (
                <motion.path
                  key={s.m.id}
                  d={curve(s)}
                  fill="none"
                  stroke={weightColor(s.m.weight)}
                  strokeWidth="1.6"
                  opacity={0.8}
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 1.2, delay: i * 0.15, ease: [0.22, 1, 0.36, 1] }}
                  style={{ filter: `drop-shadow(0 0 4px ${weightColor(s.m.weight)})` }}
                />
              ))}

              {/* auto-archive line */}
              <motion.line
                x1={PL}
                y1={y(ARCHIVE_THRESHOLD)}
                x2={W - PR}
                y2={y(ARCHIVE_THRESHOLD)}
                stroke="#ff3355"
                strokeWidth="1.2"
                strokeDasharray="6 4"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 1, 0.35, 1, 0.35, 0.9] }}
                transition={{ delay: 1.2, duration: 1.6 }}
                style={{ filter: 'drop-shadow(0 0 5px rgba(255,51,85,0.7))' }}
              />
              <text x={W - PR - 4} y={y(ARCHIVE_THRESHOLD) - 5} textAnchor="end" fill="#ff3355" fontSize="9" fontFamily="Orbitron, sans-serif" fontWeight="700">
                0.05 = AUTO-ARCHIVE
              </text>

              {/* today line */}
              <motion.line
                x1={x(90)}
                y1={PT}
                x2={x(90)}
                y2={H - PB}
                stroke="rgba(125,233,255,0.6)"
                strokeWidth="1"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ delay: 1.4, duration: 1.6, repeat: Infinity }}
              />

              {/* sample memory dots on the today line */}
              {samples.map((s, i) => (
                <motion.circle
                  key={`${s.m.id}-dot`}
                  cx={x(90)}
                  cy={y(s.m.weight)}
                  initial={{ r: 0 }}
                  animate={{ r: hover === i ? 6.5 : 4.5 }}
                  transition={{ delay: 1.3 + i * 0.15, type: 'spring', stiffness: 300, damping: 12 }}
                  fill={weightColor(s.m.weight)}
                  stroke="#02060e"
                  strokeWidth="1.5"
                  style={{ cursor: 'crosshair', filter: `drop-shadow(0 0 6px ${weightColor(s.m.weight)})` }}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
            </>
          )}
        </svg>

        {/* hover card */}
        {hover !== null && samples[hover] && (
          <div
            className="holo-panel holo-corners pointer-events-none absolute z-10 w-[210px] px-3 py-2 font-mono text-[10.5px]"
            style={{ right: '12%', top: `${(samples[hover] ? y(samples[hover].m.weight) / H : 0.3) * 100}%` }}
          >
            <div className="mb-1 line-clamp-2 font-body text-[11.5px] leading-snug text-hi">
              “{samples[hover].m.content.slice(0, 64)}…”
            </div>
            <div className="flex justify-between text-mid">
              <span>w₀ {samples[hover].w0.toFixed(2)}</span>
              <span>age {Math.round(samples[hover].ageDays)}d</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: weightColor(samples[hover].m.weight) }}>now {samples[hover].m.weight.toFixed(2)}</span>
              <span className="text-danger">archived in ~{Math.max(1, Math.round(samples[hover].archiveIn))}d</span>
            </div>
          </div>
        )}
        <div className="flex justify-between px-1 font-mono text-[9.5px] text-dim">
          <span>sample memories: hover dots for projection</span>
          <span>λ = ln2 / 30</span>
        </div>
      </div>
    </HoloPanel>
  );
}

export function WeightHistogram() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const [hover, setHover] = useState<number | null>(null);

  const buckets = useMemo(() => {
    const counts = Array.from({ length: 20 }, () => 0);
    for (const m of MEMORIES) {
      const b = Math.min(19, Math.floor(m.weight / 0.05));
      counts[b]++;
    }
    return counts;
  }, []);
  const max = Math.max(...buckets);
  const archived = MEMORIES.filter((m) => m.status === 'archived').length;

  const W = 300;
  const H = 216;
  const PT = 18;
  const PB = 24;
  const bw = W / 20;
  const barH = (c: number) => ((H - PT - PB) * c) / max;

  const colorFor = (i: number) => {
    if (i === 0) return '#ff3355';
    const mid = i * 0.05 + 0.025;
    return weightColor(mid);
  };

  return (
    <HoloPanel
      title="WEIGHT DISTRIBUTION"
      className="h-full"
      headerRight={<span className="micro-label">{MEMORIES.length} engrams</span>}
    >
      <div ref={ref} className="p-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
          {/* archive zone shading */}
          <rect x={0} y={PT} width={bw} height={H - PT - PB} fill="rgba(255,51,85,0.07)" />
          <text x={bw / 2} y={PT + 10} textAnchor="middle" fill="#ff3355" fontSize="6.5" fontFamily="Orbitron, sans-serif" fontWeight="700">
            ARCHIVE
          </text>
          {/* grid */}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={0} y1={PT + (1 - f) * (H - PT - PB)} x2={W} y2={PT + (1 - f) * (H - PT - PB)} stroke="rgba(0,212,255,.07)" />
          ))}
          {buckets.map((c, i) => (
            <g key={i}>
              {hover === i && c > 0 && (
                <text
                  x={i * bw + bw / 2}
                  y={H - PB - barH(c) - 4}
                  textAnchor="middle"
                  fill={colorFor(i)}
                  fontSize="8.5"
                  fontFamily="'JetBrains Mono', monospace"
                  fontWeight="700"
                >
                  {c}
                </text>
              )}
              <motion.rect
                x={i * bw + 1}
                y={H - PB - barH(c)}
                width={bw - 2}
                height={Math.max(0, barH(c))}
                rx={1}
                fill={colorFor(i)}
                initial={{ opacity: 0, scaleY: 0 }}
                animate={inView ? { opacity: hover === null || hover === i ? 0.9 : 0.45, scaleY: 1 } : {}}
                transition={{ delay: i * 0.025, duration: 0.4, ease: 'easeOut', opacity: { duration: 0.2 } }}
                style={{ transformBox: 'fill-box', transformOrigin: 'bottom', cursor: 'crosshair' }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          ))}
          {/* x ticks */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <text key={t} x={t * W} y={H - 8} textAnchor="middle" fill="#4b5f7c" fontSize="8.5" fontFamily="Orbitron, sans-serif">
              {t.toFixed(2)}
            </text>
          ))}
          {/* archive threshold marker */}
          <line x1={bw} y1={PT} x2={bw} y2={H - PB} stroke="#ff3355" strokeWidth="1" strokeDasharray="4 3" opacity={0.8} />
        </svg>
        <div className="mt-1 flex justify-between px-1 font-mono text-[9.5px] text-dim">
          <span>
            tiers: <span className="text-ok">STRONG</span> · <span className="text-[#ffd319]">STABLE</span> ·{' '}
            <span className="text-danger">FADING</span>
          </span>
          <span className="text-danger">{archived} archived &lt; 0.05</span>
        </div>
      </div>
    </HoloPanel>
  );
}
