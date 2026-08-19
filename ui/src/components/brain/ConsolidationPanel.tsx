import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import HoloPanel from '@/components/HoloPanel';
import SynapseTag from '@/components/SynapseTag';
import { hexA } from './anim';
import { useBrainEventsByKind } from '@/lib/use-brain-stream';

/**
 * ConsolidationPanel — brain.md §6.
 * Schema formation: clusters of ≥3 similar lessons (cosine ≥ 0.80) funnel into
 * a general task_pattern rule with violet derived_from beams back to episodes.
 * Driven by real `consolidate.cluster` events (synthetic-self Phase 8) — no
 * Math.random, no setInterval cycling through mock variants.
 */

interface Variant {
  episodes: string[];
  cos: string[];
  rule: string;
  schema: string;
  date: string;
}

// Placeholder variant shown when no consolidate.cluster events have arrived yet.
const NO_EVENTS_VARIANT: Variant = {
  episodes: [],
  cos: [],
  rule: 'awaiting consolidation events…',
  schema: '',
  date: '',
};

// episode anchor positions (% of left cluster box)
const EP_POS = [
  { x: 6, y: 6 },
  { x: 42, y: 26 },
  { x: 8, y: 52 },
  { x: 40, y: 74 },
];

export default function ConsolidationPanel() {
  const clusterEvents = useBrainEventsByKind(['consolidate.cluster']);
  const [cycle, setCycle] = useState(0);
  const [targets, setTargets] = useState<{ x: number; y: number }[] | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const funnelRef = useRef<HTMLDivElement>(null);
  const epRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Real event-driven: each consolidate.cluster event advances the display.
  useEffect(() => {
    if (clusterEvents.length === 0) return;
    setCycle((c) => c + 1);
  }, [clusterEvents]);

  const variant: Variant = clusterEvents.length > 0
    ? {
        episodes: [`cluster event #${clusterEvents.length}`],
        cos: [],
        rule: `Synthesized ${clusterEvents[clusterEvents.length - 1]!.payload.rulesSynthesized ?? 1} rule(s) from episodic consolidation`,
        schema: `SCHEMA #${cycle}`,
        date: 'now',
      }
    : NO_EVENTS_VARIANT;

  // measure episode → funnel drift deltas per cycle
  useLayoutEffect(() => {
    setTargets(null);
    const raf = requestAnimationFrame(() => {
      const stage = stageRef.current;
      const funnel = funnelRef.current;
      if (!stage || !funnel) return;
      const fr = funnel.getBoundingClientRect();
      const fx = fr.left + fr.width / 2;
      const fy = fr.top + fr.height / 2;
      const t = variant.episodes.map((_, i) => {
        const el = epRefs.current[i];
        if (!el) return { x: 0, y: 0 };
        const r = el.getBoundingClientRect();
        return { x: fx - (r.left + r.width / 2), y: fy - (r.top + r.height / 2) };
      });
      setTargets(t);
    });
    return () => cancelAnimationFrame(raf);
  }, [cycle, variant]);

  return (
    <HoloPanel
      title="CONSOLIDATE · EPISODIC → SEMANTIC"
      className="h-full"
      headerRight={<span className="micro-label">metric: schema_formation</span>}
    >
      <div className="p-4">
        {/* two-stage diagram */}
        <div ref={stageRef} className="relative flex h-[240px] items-stretch gap-2">
          {/* left: episode cluster */}
          <div className="relative w-[42%] shrink-0">
            {/* similarity web */}
            <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
              {variant.episodes.slice(1).map((_, i) => {
                const a = EP_POS[i];
                const b = EP_POS[i + 1];
                return (
                  <g key={i}>
                    <line
                      x1={a.x + 6}
                      y1={a.y + 8}
                      x2={b.x + 6}
                      y2={b.y + 8}
                      stroke="rgba(255,51,85,0.3)"
                      strokeWidth="0.4"
                      strokeDasharray="2 1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x={(a.x + b.x) / 2 + 6}
                      y={(a.y + b.y) / 2 + 6}
                      fill="rgba(143,169,199,0.8)"
                      fontSize="4"
                      fontFamily="'JetBrains Mono', monospace"
                    >
                      cos {variant.cos[i]}
                    </text>
                  </g>
                );
              })}
            </svg>
            {variant.episodes.map((ep, i) => (
              <motion.div
                key={`${cycle}-${i}`}
                ref={(el) => {
                  epRefs.current[i] = el;
                }}
                className="absolute flex max-w-[62%] items-center gap-1.5"
                style={{ left: `${EP_POS[i].x}%`, top: `${EP_POS[i].y}%` }}
                initial={{ x: 0, y: 0, opacity: 1 }}
                animate={
                  targets
                    ? { x: targets[i].x, y: targets[i].y, opacity: [1, 1, 0] }
                    : { x: 0, y: 0, opacity: 1 }
                }
                transition={{
                  delay: 2 + i * 0.2,
                  duration: 1.2,
                  ease: [0.22, 1, 0.36, 1],
                  opacity: { delay: 2 + i * 0.2, duration: 1.2, times: [0, 0.8, 1] },
                }}
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-danger shadow-[0_0_6px_var(--danger)]" />
                <span className="truncate rounded border border-[rgba(255,51,85,0.3)] bg-[rgba(255,51,85,0.07)] px-1.5 py-0.5 font-mono text-[9.5px] text-mid">
                  {ep}
                </span>
              </motion.div>
            ))}
            <span className="micro-label absolute bottom-0 left-0">episodes · lesson_learned</span>
          </div>

          {/* center: funnel / synthesizer */}
          <div className="relative flex w-[16%] shrink-0 items-center justify-center">
            <motion.div
              ref={funnelRef}
              key={cycle}
              className="h-16 w-16"
              animate={{ rotate: 360, scale: [1, 1, 1.18, 1] }}
              transition={{
                rotate: { duration: 14, repeat: Infinity, ease: 'linear' },
                scale: { delay: 3.1, duration: 0.6, times: [0, 0.5, 0.7, 1] },
              }}
            >
              <img
                src="/boot-reactor.svg"
                alt="Schema synthesizer"
                className="h-full w-full"
                style={{ filter: 'hue-rotate(140deg) drop-shadow(0 0 10px rgba(178,107,255,0.5))' }}
              />
            </motion.div>
            <motion.span
              key={`flash-${cycle}`}
              className="absolute h-16 w-16 rounded-full"
              style={{ background: 'radial-gradient(circle, rgba(178,107,255,0.5), transparent 70%)' }}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: [0, 0, 1, 0], scale: [0.6, 0.6, 1.4, 1.6] }}
              transition={{ duration: 1, delay: 3.0, times: [0, 0.45, 0.7, 1] }}
            />
            <span className="micro-label absolute bottom-0 whitespace-nowrap">synthesizer</span>
          </div>

          {/* right: synthesized rule + derived_from beams */}
          <div className="relative min-w-0 flex-1">
            {/* beams from funnel to episode origins */}
            <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
              {variant.episodes.map((_, i) => (
                <motion.line
                  key={`${cycle}-beam-${i}`}
                  x1="2"
                  y1="50"
                  x2={-((EP_POS[i].x - 50) * 0.4)}
                  y2={EP_POS[i].y}
                  stroke="#b26bff"
                  strokeWidth="1.2"
                  vectorEffect="non-scaling-stroke"
                  style={{ filter: 'drop-shadow(0 0 3px rgba(178,107,255,0.7))' }}
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 0.55 }}
                  transition={{ delay: 3.8 + i * 0.1, duration: 0.6 }}
                />
              ))}
            </svg>
            <div className="flex h-full items-center">
              <motion.div
                key={`${cycle}-rule`}
                className="holo-corners relative ml-4 w-full rounded-md border border-[rgba(34,255,136,0.35)] bg-[rgba(34,255,136,0.06)] p-3"
                initial={{ clipPath: 'inset(0 100% 0 0)', opacity: 0 }}
                animate={{ clipPath: 'inset(0 0% 0 0)', opacity: 1 }}
                transition={{ delay: 3.5, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <SynapseTag label="task_pattern" color="#22ff88" />
                  <SynapseTag label={`derived_from ×${variant.episodes.length}`} color="#b26bff" />
                </div>
                <p className="text-[13px] leading-snug text-hi">“{variant.rule}”</p>
                <div className="mt-1.5 font-mono text-[10px]" style={{ color: hexA('#b26bff', 0.9) }}>
                  {variant.schema} · consolidated {variant.date} · {variant.episodes.length} episodes → 1 rule
                </div>
              </motion.div>
            </div>
            <span className="micro-label absolute bottom-0 right-0">semantic rule</span>
          </div>
        </div>

        {/* history */}
        <div className="holo-divider my-3" />
        <div className="flex flex-col gap-1">
          <span className="micro-label">consolidation history</span>
          {clusterEvents.length === 0 ? (
            <span className="font-mono text-[10.5px] text-dim">no consolidation events yet — events arrive on compaction</span>
          ) : (
            clusterEvents.slice(-4).reverse().map((ev, i) => (
              <span key={ev.seq} className="font-mono text-[10.5px] text-dim">
                {`SCHEMA #${cycle - i} · ${ev.recordedAt.slice(11, 19)} · ${(ev.payload.rulesSynthesized as number) ?? 1} rule(s) synthesized`}
              </span>
            ))
          )}
        </div>
      </div>
    </HoloPanel>
  );
}
