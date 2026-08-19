import { motion } from 'framer-motion';
import { DecodeText, Reveal, useLenis } from '@/components/brain/anim';
import ArousalGauge from '@/components/brain/ArousalGauge';
import BrainLoopPipeline from '@/components/brain/BrainLoopPipeline';
import ReflexCore from '@/components/brain/ReflexCore';
import PredictPanel from '@/components/brain/PredictPanel';
import WorkingMemoryWindow from '@/components/brain/WorkingMemoryWindow';
import ConsolidationPanel from '@/components/brain/ConsolidationPanel';
import ScrubPanel from '@/components/brain/ScrubPanel';
import { useBrainStream, type LivenessBadge } from '@/lib/use-brain-stream';

/**
 * SYNTHETIC BRAIN (/brain) — brain.md.
 * Mission-control of the six cognitive subsystems: brain-loop, reflex,
 * predict, working memory, consolidate, scrub. Driven by real brain events
 * (synthetic-self Phase 8) — the LIVE/STALE/DEMO badge reflects real event
 * recency, not a simulation.
 */
const BADGE_CONFIG: Record<LivenessBadge, { label: string; color: string; bg: string }> = {
  live: { label: 'LIVE', color: '#22ff88', bg: 'rgba(34,255,136,0.12)' },
  stale: { label: 'STALE', color: '#ffb627', bg: 'rgba(255,182,39,0.12)' },
  idle: { label: 'IDLE', color: '#7de9ff', bg: 'rgba(125,233,255,0.08)' },
  empty: { label: 'NO SIGNAL', color: '#8a97ab', bg: 'rgba(138,151,171,0.08)' },
  demo: { label: 'DEMO', color: '#8a97ab', bg: 'rgba(138,151,171,0.08)' },
};

export default function Brain() {
  useLenis();
  const { badge } = useBrainStream();
  const badgeCfg = BADGE_CONFIG[badge];

  return (
    <div className="relative z-10 mx-auto w-full max-w-[1500px] px-4 pb-16 pt-8 lg:px-8">
      {/* SECTION 1 — header + arousal strip */}
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-[0.14em] text-hi text-glow lg:text-[30px]">
            <DecodeText text="SYNTHETIC BRAIN" duration={600} />
          </h1>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.35 }}
            className="mt-1 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-dim"
          >
            <span>Cognitive Subsystems</span>
            <span className="text-dim">·</span>
            {/* LIVE/STALE/DEMO badge — driven by real event recency (§5.5) */}
            <span
              className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-bold tracking-[0.18em]"
              style={{
                color: badgeCfg.color,
                borderColor: badgeCfg.color,
                backgroundColor: badgeCfg.bg,
                boxShadow: badge === 'live' ? `0 0 10px ${badgeCfg.color}40` : undefined,
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor: badgeCfg.color,
                  boxShadow: badge === 'live' ? `0 0 6px ${badgeCfg.color}` : undefined,
                  animation: badge === 'live' ? 'led-pulse 1.6s ease-in-out infinite' : undefined,
                }}
              />
              {badgeCfg.label}
            </span>
          </motion.div>
        </div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <ArousalGauge />
        </motion.div>
      </header>

      {/* subsystem grid */}
      <div className="mt-6 grid grid-cols-12 gap-4">
        {/* SECTION 2 — brain-loop pipeline (full width) */}
        <Reveal className="col-span-12">
          <BrainLoopPipeline />
        </Reveal>

        {/* SECTIONS 3 + 4 — reflex core + predict (7 + 5) */}
        <Reveal className="col-span-12 xl:col-span-7" amount={0.15}>
          <ReflexCore />
        </Reveal>
        <Reveal className="col-span-12 xl:col-span-5" amount={0.15} delay={0.1}>
          <PredictPanel />
        </Reveal>

        {/* SECTION 5 — working memory window (full width) */}
        <Reveal className="col-span-12" amount={0.2}>
          <WorkingMemoryWindow />
        </Reveal>

        {/* SECTIONS 6 + 7 — consolidate + scrub (7 + 5) */}
        <Reveal className="col-span-12 xl:col-span-7" amount={0.15}>
          <ConsolidationPanel />
        </Reveal>
        <Reveal className="col-span-12 xl:col-span-5" amount={0.15} delay={0.1}>
          <ScrubPanel />
        </Reveal>
      </div>
    </div>
  );
}
