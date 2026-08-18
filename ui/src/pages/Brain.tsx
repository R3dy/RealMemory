import { motion } from 'framer-motion';
import { DecodeText, Reveal, useLenis } from '@/components/brain/anim';
import ArousalGauge from '@/components/brain/ArousalGauge';
import BrainLoopPipeline from '@/components/brain/BrainLoopPipeline';
import ReflexCore from '@/components/brain/ReflexCore';
import PredictPanel from '@/components/brain/PredictPanel';
import WorkingMemoryWindow from '@/components/brain/WorkingMemoryWindow';
import ConsolidationPanel from '@/components/brain/ConsolidationPanel';
import ScrubPanel from '@/components/brain/ScrubPanel';

/**
 * SYNTHETIC BRAIN (/brain) — brain.md.
 * Mission-control of the six cognitive subsystems: brain-loop, reflex,
 * predict, working memory, consolidate, scrub.
 */
export default function Brain() {
  useLenis();

  return (
    <div className="relative z-10 mx-auto w-full max-w-[1500px] px-4 pb-16 pt-8 lg:px-8">
      {/* SECTION 1 — header + arousal strip */}
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-[0.14em] text-hi text-glow lg:text-[30px]">
            <DecodeText text="SYNTHETIC BRAIN" duration={600} />
          </h1>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.35 }}
            className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-dim"
          >
            Cognitive Subsystems · Live Telemetry (Simulated)
          </motion.p>
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
