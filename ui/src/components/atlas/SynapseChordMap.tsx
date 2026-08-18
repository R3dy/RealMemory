import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { EDGE_COLORS } from '@/lib/colors';
import type { CrossDomainLink, DomainStats } from './domain-stats';
import { cn } from '@/lib/utils';

const W = 1000;
const H = 320;
const CX = W / 2;
const CY = H / 2 + 6;
const RX = 400;
const RY = 108;

interface SectorPoint {
  name: string;
  x: number;
  y: number;
  count: number;
}

/**
 * SynapseChordMap — domains.md §3.
 * The 8 domains on an ellipse; arcs = cross-domain relationships.
 * Thickness ∝ edge count, color = dominant edge type between the pair.
 */
export default function SynapseChordMap({
  domains,
  links,
}: {
  domains: DomainStats[];
  links: CrossDomainLink[];
}) {
  const [hoverSector, setHoverSector] = useState<string | null>(null);
  const [hoverLink, setHoverLink] = useState<CrossDomainLink | null>(null);

  // alphabetical around the ellipse for a stable star-chart layout
  const sectors = useMemo<SectorPoint[]>(() => {
    const names = domains.map((d) => d.name).sort();
    const counts = new Map(domains.map((d) => [d.name, d.count]));
    return names.map((name, i) => {
      // start at top, distribute clockwise
      const a = -Math.PI / 2 + (i / names.length) * Math.PI * 2;
      return {
        name,
        x: CX + RX * Math.cos(a),
        y: CY + RY * Math.sin(a),
        count: counts.get(name) ?? 0,
      };
    });
  }, [domains]);

  const byName = useMemo(() => new Map(sectors.map((s) => [s.name, s])), [sectors]);
  const maxCount = Math.max(1, ...links.map((l) => l.count));
  const maxSectorCount = Math.max(1, ...sectors.map((s) => s.count));

  const crossTotal = useMemo(() => links.reduce((s, l) => s + l.count, 0), [links]);
  const perSector = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of links) {
      m.set(l.a, (m.get(l.a) ?? 0) + l.count);
      m.set(l.b, (m.get(l.b) ?? 0) + l.count);
    }
    return m;
  }, [links]);

  const readout = hoverLink
    ? `${hoverLink.a.toUpperCase()} ↔ ${hoverLink.b.toUpperCase()} · ${hoverLink.count} SYNAPSES · mostly ${hoverLink.dominant}`
    : hoverSector
      ? `${hoverSector.toUpperCase()} · ${perSector.get(hoverSector) ?? 0} CROSS-SECTOR SYNAPSES`
      : `${links.length} SECTOR PAIRS · ${crossTotal} CROSS-DOMAIN SYNAPSES`;

  const arcPath = (p: SectorPoint, q: SectorPoint) => {
    // quadratic bezier pulled toward the center for the chord look
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const cxp = mx + (CX - mx) * 0.55;
    const cyp = my + (CY - my) * 0.55;
    return `M ${p.x} ${p.y} Q ${cxp} ${cyp} ${q.x} ${q.y}`;
  };

  return (
    <div className="relative">
      {/* readout pill */}
      <div className="pointer-events-none absolute right-3 top-2 z-10 rounded-full border border-panel-border bg-[rgba(2,6,14,0.7)] px-3 py-1 font-mono text-[11px] text-arc backdrop-blur-sm">
        {readout}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Inter-sector synapse map">
        {/* faint ellipse guide */}
        <ellipse
          cx={CX}
          cy={CY}
          rx={RX}
          ry={RY}
          fill="none"
          stroke="rgba(0,212,255,0.08)"
          strokeDasharray="3 6"
        />
        {/* arcs */}
        {links.map((l, i) => {
          const p = byName.get(l.a);
          const q = byName.get(l.b);
          if (!p || !q) return null;
          const color = EDGE_COLORS[l.dominant];
          const touched = hoverSector === l.a || hoverSector === l.b;
          const dimmed = hoverSector !== null && !touched && hoverLink !== l;
          const hot = hoverLink === l || touched;
          return (
            <motion.path
              key={`${l.a}|${l.b}`}
              d={arcPath(p, q)}
              fill="none"
              stroke={color}
              strokeWidth={1 + (l.count / maxCount) * 5}
              strokeLinecap="round"
              initial={{ pathLength: 0 }}
              whileInView={{ pathLength: 1 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.7, delay: 0.3 + i * 0.08, ease: 'easeOut' }}
              style={{
                opacity: dimmed ? 0.1 : hot ? 0.95 : 0.5,
                filter: hot ? `drop-shadow(0 0 5px ${color})` : undefined,
                transition: 'opacity 200ms',
                cursor: 'pointer',
              }}
              onMouseEnter={() => setHoverLink(l)}
              onMouseLeave={() => setHoverLink(null)}
            />
          );
        })}
        {/* sector nodes */}
        {sectors.map((s, i) => {
          const hot = hoverSector === s.name;
          const dimmed = hoverSector !== null && !hot;
          const r = 5 + (s.count / maxSectorCount) * 7;
          const labelX = s.x + (s.x > CX + 10 ? 14 : s.x < CX - 10 ? -14 : 0);
          const labelY = s.y + (Math.abs(s.x - CX) <= 10 ? (s.y < CY ? -16 : 20) : 4);
          return (
            <motion.g
              key={s.name}
              initial={{ scale: 0, opacity: 0 }}
              whileInView={{ scale: 1, opacity: 1 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ type: 'spring', stiffness: 400, damping: 22, delay: i * 0.06 }}
              style={{ transformOrigin: `${s.x}px ${s.y}px`, cursor: 'pointer' }}
              onMouseEnter={() => setHoverSector(s.name)}
              onMouseLeave={() => setHoverSector(null)}
            >
              <circle
                cx={s.x}
                cy={s.y}
                r={r + 5}
                fill="none"
                stroke="var(--arc)"
                strokeOpacity={hot ? 0.8 : 0.25}
                strokeDasharray="2 4"
              />
              <circle
                cx={s.x}
                cy={s.y}
                r={r}
                fill="var(--arc)"
                fillOpacity={dimmed ? 0.25 : 0.9}
                style={{ filter: hot ? 'drop-shadow(0 0 8px var(--arc))' : 'drop-shadow(0 0 3px rgba(0,212,255,0.6))', transition: 'fill-opacity 200ms' }}
              />
              <circle cx={s.x} cy={s.y} r={2} fill="#02060e" />
              <motion.text
                x={labelX}
                y={labelY}
                textAnchor={s.x > CX + 10 ? 'start' : s.x < CX - 10 ? 'end' : 'middle'}
                initial={{ opacity: 0, y: 6 }}
                whileInView={{ opacity: dimmed ? 0.35 : 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.4, delay: 0.5 + i * 0.06 }}
                className={cn('fill-[#8fa9c7] font-mono', hot && 'fill-[#e8f6ff]')}
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', transition: 'fill 200ms' }}
              >
                {s.name}
              </motion.text>
            </motion.g>
          );
        })}
      </svg>
      {/* edge-type legend */}
      <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
        {Object.entries(EDGE_COLORS).map(([type, color]) => (
          <span key={type} className="flex items-center gap-1.5 font-mono text-[10px] uppercase text-dim">
            <span className="inline-block h-[2px] w-4 rounded-full" style={{ backgroundColor: color }} />
            {type}
          </span>
        ))}
      </div>
    </div>
  );
}
